//! Talk — an async system's conversation with the host, while it is going.
//!
//! The same messages a Python process speaks, over a different transport: the
//! host tells this module `job`, `answer`, `event`, `end` and `cancel`
//! (`tell`), and the module says `call`, `effect`, `stop`, `done`, `error` and
//! `cancelled` through `out`.
//! Each job runs its system's future on a thread of its own, so a run waiting
//! on a model holds up no other — and never the tick.

use std::cell::RefCell;
use std::collections::HashMap;
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures::channel::{mpsc, oneshot};
use futures::{pin_mut, select, FutureExt, StreamExt};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::array::{scope, Block};
use crate::kernel::{self, Effect};
use crate::run::{Run, Snapshot};
use crate::serve::{panics, Body, Served};
use crate::Fault;

/// How this module speaks to the host: one message, as text.
pub type Out = Arc<dyn Fn(String) + Send + Sync>;

/// A call's answer: its value as JSON and the blocks its markers name — or the kernel's refusal.
type Answer = Result<(String, Vec<Block>), Fault>;

/// One answer of a stream: an event, or the error that stopped it. Its end closes the channel.
type Streamed = Result<(String, Vec<Block>), Fault>;

/// One job's side of the conversation: what it says, the calls it is waiting on, and the streams it is reading.
pub(crate) struct Talk {
    job: u64,
    out: Out,
    calls: Mutex<HashMap<u64, oneshot::Sender<Answer>>>,
    streams: Mutex<HashMap<u64, mpsc::UnboundedSender<Streamed>>>,
    next: AtomicU64,
}

impl Talk {
    fn say(&self, message: Value) {
        (self.out)(message.to_string());
    }

    /// An effect, sent now: an async run's leave as it makes them.
    pub(crate) fn effect(&self, effect: &Effect) -> Result<(), Fault> {
        let text = serde_json::to_string(effect)?;
        self.say(json!({ "kind": "effect", "job": self.job, "effect": text, "kinds": [], "arrays": [] }));
        Ok(())
    }

    /// A call, and its answer — arrays crossing as memory both ways.
    pub(crate) async fn ask<T: DeserializeOwned>(&self, op: &str, args: impl Serialize) -> Result<T, Fault> {
        let mut blocks = Vec::new();
        let args = scope::writing(&mut blocks, || serde_json::to_string(&args))?;
        let call = self.next.fetch_add(1, Ordering::Relaxed);
        let (send, answered) = oneshot::channel();
        self.calls.lock().expect("a call table is never poisoned: nothing panics holding it").insert(call, send);
        let (kinds, arrays) = encoded(&blocks);
        self.say(json!({ "kind": "call", "job": self.job, "call": call, "op": op, "args": args, "kinds": kinds, "arrays": arrays }));
        let (value, blocks) = answered.await.map_err(|_| Fault::new(format!("the host stopped answering {op}")))??;
        let blocks: Rc<[Block]> = blocks.into();
        scope::reading(&blocks, || serde_json::from_str(&value)).map_err(|cause| Fault::new(format!("the answer to {op} was not what was asked for: {cause}")))
    }
}

impl Talk {
    /// A streamed call: its answers as they come, read through `Events`.
    pub(crate) fn stream<T: DeserializeOwned>(self: &Arc<Self>, op: &str, args: impl Serialize) -> Result<Events<T>, Fault> {
        let mut blocks = Vec::new();
        let args = scope::writing(&mut blocks, || serde_json::to_string(&args))?;
        let call = self.next.fetch_add(1, Ordering::Relaxed);
        let (send, events) = mpsc::unbounded();
        self.streams.lock().expect("a stream table is never poisoned").insert(call, send);
        let (kinds, arrays) = encoded(&blocks);
        self.say(json!({ "kind": "call", "job": self.job, "call": call, "op": op, "args": args, "kinds": kinds, "arrays": arrays }));
        Ok(Events { talk: self.clone(), call: call, op: op.to_string(), events: events, ended: false, of: PhantomData })
    }
}

/// A stream's answers, in order. Dropped before its end, it tells the host to stop.
pub struct Events<T> {
    talk: Arc<Talk>,
    call: u64,
    op: String,
    events: mpsc::UnboundedReceiver<Streamed>,
    ended: bool,
    of: PhantomData<T>,
}

impl<T: DeserializeOwned> Events<T> {
    /// The next answer; `None` once it has ended.
    pub async fn next(&mut self) -> Option<Result<T, Fault>> {
        if self.ended {
            return None;
        }
        let Some(streamed) = self.events.next().await else {
            self.ended = true;
            return None;
        };
        Some(streamed.and_then(|(value, blocks)| {
            let blocks: Rc<[Block]> = blocks.into();
            scope::reading(&blocks, || serde_json::from_str(&value)).map_err(|cause| Fault::new(format!("an answer of {} was not what was asked for: {cause}", self.op)))
        }).inspect_err(|_| self.ended = true))
    }
}

impl<T> Drop for Events<T> {
    fn drop(&mut self) {
        // Still open: the host is told to stop. Ended, or never read past an error, it has nothing more to say.
        let open = self.talk.streams.lock().expect("a stream table is never poisoned").remove(&self.call).is_some();
        if open && !self.ended {
            self.talk.say(json!({ "kind": "stop", "job": self.talk.job, "call": self.call }));
        }
    }
}

thread_local! {
    /// The conversation of the async run this thread is running: what a handle is released through.
    static CURRENT: RefCell<Option<Arc<Talk>>> = const { RefCell::new(None) };
}

/// The conversation of the async run on this thread, if it is running one.
pub(crate) fn current() -> Option<Arc<Talk>> {
    CURRENT.with(|cell| cell.borrow().clone())
}

/// A job in flight: its conversation, and how to cancel it.
struct Live {
    talk: Arc<Talk>,
    cancel: Option<oneshot::Sender<()>>,
}

fn jobs() -> &'static Mutex<HashMap<u64, Live>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Live>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What the host told this module. A message it cannot read is a fault: the transport is broken.
pub fn tell(systems: &'static [Served], text: &str, out: Out) -> Result<(), Fault> {
    #[derive(Deserialize)]
    struct Told {
        kind: String,
        job: u64,
    }
    let told: Told = serde_json::from_str(text).map_err(|cause| Fault::new(format!("the host told this module something it cannot read: {cause}")))?;
    match told.kind.as_str() {
        "job" => start(systems, text, out),
        "answer" => answer(told.job, text),
        "event" => streamed(told.job, text, true),
        "end" => streamed(told.job, text, false),
        "cancel" => {
            if let Some(live) = jobs().lock().expect("the job table is never poisoned").get_mut(&told.job) {
                if let Some(cancel) = live.cancel.take() {
                    let _ = cancel.send(());
                }
            }
            Ok(())
        }
        other => Err(Fault::new(format!("the host told this module {other}, which it does not know"))),
    }
}

/// A new job: its snapshot read here — where the state this module was last sent is kept — and its run on a thread.
fn start(systems: &'static [Served], text: &str, out: Out) -> Result<(), Fault> {
    #[derive(Deserialize)]
    struct Job {
        job: u64,
        system: String,
        snapshot: String,
        kinds: Vec<String>,
        arrays: Vec<String>,
    }
    let job: Job = serde_json::from_str(text)?;
    let served = systems.iter().find(|one| one.name == job.system).ok_or_else(|| Fault::new(format!("this module holds no system \"{}\"", job.system)))?;
    let Body::Async(body) = served.body else { return Err(Fault::new(format!("{} is not async — it runs in the tick, not in a conversation", job.system))) };
    let mut snapshot = Snapshot::parse(&job.snapshot, decoded(&job.kinds, &job.arrays)?)?;
    let state = kernel::state(snapshot.state.take());

    let talk = Arc::new(Talk { job: job.job, out: out, calls: Mutex::new(HashMap::new()), streams: Mutex::new(HashMap::new()), next: AtomicU64::new(0) });
    let (cancel, cancelled) = oneshot::channel::<()>();
    jobs().lock().expect("the job table is never poisoned").insert(job.job, Live { talk: talk.clone(), cancel: Some(cancel) });

    let name = served.name;
    std::thread::spawn(move || {
        panics::quiet();
        CURRENT.with(|cell| *cell.borrow_mut() = Some(talk.clone()));
        let said = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut run = Run::talking(snapshot, state, talk.clone());
            let outcome = futures::executor::block_on(async {
                let running = body(&mut run).fuse();
                let cancelled = cancelled.fuse();
                pin_mut!(running, cancelled);
                select! {
                    result = running => Some(result),
                    _ = cancelled => None,
                }
            });
            match outcome {
                None => json!({ "kind": "cancelled", "job": job.job }),
                Some(Err(fault)) => json!({ "kind": "error", "job": job.job, "error": fault.message() }),
                Some(Ok(())) => match run.finish().json_with_blocks() {
                    Ok((ran, blocks)) => {
                        let (kinds, arrays) = encoded(&blocks);
                        json!({ "kind": "done", "job": job.job, "ran": ran, "kinds": kinds, "arrays": arrays })
                    }
                    Err(fault) => json!({ "kind": "error", "job": job.job, "error": fault.message() }),
                },
            }
        }));
        let said = said.unwrap_or_else(|payload| json!({ "kind": "error", "job": job.job, "error": format!("{name} panicked: {}", panics::said(payload)) }));
        CURRENT.with(|cell| *cell.borrow_mut() = None);
        jobs().lock().expect("the job table is never poisoned").remove(&job.job);
        talk.say(said);
    });
    Ok(())
}

/// A call's answer, delivered to the run waiting on it.
fn answer(job: u64, text: &str) -> Result<(), Fault> {
    #[derive(Deserialize)]
    struct Answered {
        call: u64,
        value: Option<String>,
        #[serde(default)]
        kinds: Vec<String>,
        #[serde(default)]
        arrays: Vec<String>,
        error: Option<Refused>,
    }
    #[derive(Deserialize)]
    struct Refused {
        code: String,
        message: String,
    }
    let answered: Answered = serde_json::from_str(text)?;
    let talk = jobs().lock().expect("the job table is never poisoned").get(&job).map(|live| live.talk.clone());
    // A job already finished — cancelled while its call was answered — has no one waiting.
    let Some(talk) = talk else { return Ok(()) };
    // A stream is answered once only when it fails: the error that stopped it.
    if let Some(stream) = talk.streams.lock().expect("a stream table is never poisoned").remove(&answered.call) {
        let refused = answered.error.ok_or_else(|| Fault::new(format!("the host answered stream {} of job {job} with a value", answered.call)))?;
        let _ = stream.unbounded_send(Err(Fault::coded(refused.code, refused.message)));
        return Ok(());
    }
    let waiting = talk.calls.lock().expect("a call table is never poisoned").remove(&answered.call).ok_or_else(|| Fault::new(format!("the host answered call {} of job {job}, which nobody asked", answered.call)))?;
    let reply = match (answered.value, answered.error) {
        (_, Some(refused)) => Err(Fault::coded(refused.code, refused.message)),
        (Some(value), None) => decoded(&answered.kinds, &answered.arrays).map(|blocks| (value, blocks)),
        (None, None) => Err(Fault::new("the host answered with neither a value nor a refusal")),
    };
    let _ = waiting.send(reply);
    Ok(())
}

/// One event of a stream — or its end — delivered to the run reading it.
fn streamed(job: u64, text: &str, event: bool) -> Result<(), Fault> {
    #[derive(Deserialize)]
    struct Heard {
        call: u64,
        value: Option<String>,
        #[serde(default)]
        kinds: Vec<String>,
        #[serde(default)]
        arrays: Vec<String>,
    }
    let heard: Heard = serde_json::from_str(text)?;
    let talk = jobs().lock().expect("the job table is never poisoned").get(&job).map(|live| live.talk.clone());
    let Some(talk) = talk else { return Ok(()) };
    let mut streams = talk.streams.lock().expect("a stream table is never poisoned");
    // A stream already stopped — the run moved on before the host heard — has no one reading.
    let Some(stream) = streams.get(&heard.call) else { return Ok(()) };
    if !event {
        streams.remove(&heard.call);
        return Ok(());
    }
    let value = heard.value.ok_or_else(|| Fault::new("the host sent an event with no value"))?;
    let _ = stream.unbounded_send(decoded(&heard.kinds, &heard.arrays).map(|blocks| (value, blocks)));
    Ok(())
}

fn decoded(kinds: &[String], arrays: &[String]) -> Result<Vec<Block>, Fault> {
    if kinds.len() != arrays.len() {
        return Err(Fault::new(format!("{} kinds for {} arrays", kinds.len(), arrays.len())));
    }
    kinds.iter().zip(arrays).map(|(kind, text)| {
        let bytes = base64::decode(text).map_err(|cause| Fault::new(format!("an array is not base64: {cause}")))?;
        Block::from_bytes(kind, &bytes)
    }).collect()
}

fn encoded(blocks: &[Block]) -> (Vec<&'static str>, Vec<String>) {
    (blocks.iter().map(Block::kind).collect(), blocks.iter().map(|block| base64::encode(block.bytes())).collect())
}

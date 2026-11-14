//! The kernel, as a Rust system reaches it: effects it asks for, and the
//! state the body and the sandbox were in when the run began.
//!
//! An effect needs no answer. A sync run's are held and cross back with its
//! changes — made when the run lands, in order, exactly as a TypeScript
//! system's. An async run's leave as it makes them. A call needs an answer, so
//! only an async run — one with a conversation — may make one.

use std::cell::RefCell;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::services::ServiceStates;
use crate::talk::Talk;
use crate::Fault;

/// What this crate's kernel implements, as the runtime's verb table names it — held to
/// `tests/contract/verbs.json` with the runtime's and the Python runtime's.
pub const SURFACE: Surface = Surface {
    effects: &["output", "emit", "fault", "release", "reset", "close"],
    state: &["body", "presence", "scope", "services"],
    calls: &[
        "service.call",
        "service.stream",
        "service.open",
        "service.push",
        "run",
        "store.get",
        "store.set",
        "store.session",
        "knowledge.list",
        "knowledge.read",
        "knowledge.write",
        "knowledge.remove",
        "memory.connect",
        "base",
    ],
};

/// Effects, state and calls, by name.
pub struct Surface {
    pub effects: &'static [&'static str],
    pub state: &'static [&'static str],
    pub calls: &'static [&'static str],
}

/// The kernel for one run.
pub struct Kernel {
    state: Option<Arc<State>>,
    effects: Vec<Effect>,
    /// How an async run speaks to the host while it is going; a sync run has none.
    talk: Option<Arc<Talk>>,
    pub store: Store,
    pub knowledge: Knowledge,
    pub memory: Memory,
}

/// One effect, as it crosses back: `{ verb, args }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Effect {
    pub verb: &'static str,
    pub args: Value,
}

/// What the body and the sandbox said they were, numbered so a module keeps it until it changes.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct State {
    pub rev: u64,
    // TEMP (2026-10-13): raw JSON until the schema readers express tagged unions; then `Manifest`, `Presence` and
    // `Scope` are generated from @arcforge/types like every component, never hand-written beside it.
    pub body: Value,
    pub presence: Value,
    pub scope: Value,
    /// Each use the cognet declares, as it stands — what `run.services` answers `available` and `describe` from.
    pub services: ServiceStates,
}

impl Kernel {
    pub(crate) fn new(state: Option<Arc<State>>, talk: Option<Arc<Talk>>) -> Self {
        let asker = Asker { talk: talk.clone() };
        Self { state: state, effects: Vec::new(), talk: talk, store: Store { asker: asker.clone() }, knowledge: Knowledge { asker: asker.clone() }, memory: Memory { asker: asker } }
    }

    /// Tells the body something. A sync run's is made when the run lands; an async run's, now.
    pub fn output(&mut self, output: Output) -> Result<(), Fault> {
        self.effect(Effect { verb: "output", args: json!({ "type": output.kind, "data": output.data }) })
    }

    /// The mind's own telemetry: `type` is `cognet:…`.
    pub fn emit(&mut self, kind: &str, data: impl Serialize) -> Result<(), Fault> {
        let data = serde_json::to_value(data)?;
        self.effect(Effect { verb: "emit", args: json!({ "type": kind, "data": data }) })
    }

    /// Reports a model breaking the mind's grammar, for the model to see next time.
    pub fn fault(&mut self, code: &str, message: &str, excerpt: Option<&str>) -> Result<(), Fault> {
        let mut args = json!({ "code": code, "message": message });
        if let Some(excerpt) = excerpt {
            args["excerpt"] = Value::from(excerpt);
        }
        self.effect(Effect { verb: "fault", args: args })
    }

    /// What the body said it is, as the run began. `None` while no body is worn.
    pub fn body(&self) -> Result<Option<&Value>, Fault> {
        let held = self.held()?;
        Ok(if held.body.is_null() { None } else { Some(&held.body) })
    }

    /// Whether the body is the mind's to move, as the run began. `None` until the body says.
    pub fn presence(&self) -> Result<Option<&Value>, Fault> {
        let held = self.held()?;
        Ok(if held.presence.is_null() { None } else { Some(&held.presence) })
    }

    /// What the sandbox can run, as the run began.
    pub fn scope(&self) -> Result<&Value, Fault> {
        Ok(&self.held()?.scope)
    }

    /// Runs code in the agent's sandbox, checked against its policy. Never refused here: failure is a result.
    pub async fn run(&self, code: &str) -> Result<RunResult, Fault> {
        Asker { talk: self.talk.clone() }.ask("run", json!({ "code": code })).await
    }

    /// Runs several blocks of code at once; the results in order.
    pub async fn run_all(&self, code: &[&str]) -> Result<Vec<RunResult>, Fault> {
        Asker { talk: self.talk.clone() }.ask("run", json!({ "code": code })).await
    }

    /// The user's identity text for this agent. Empty when there is none.
    pub async fn base(&self) -> Result<String, Fault> {
        Asker { talk: self.talk.clone() }.ask("base", json!({})).await
    }

    fn effect(&mut self, effect: Effect) -> Result<(), Fault> {
        match &self.talk {
            Some(talk) => talk.effect(&effect),
            None => {
                self.effects.push(effect);
                Ok(())
            }
        }
    }

    fn held(&self) -> Result<&State, Fault> {
        self.state.as_deref().ok_or_else(|| Fault::new("this run has no kernel state — a worker system has no kernel"))
    }

    pub(crate) fn finish(self) -> Vec<Effect> {
        self.effects
    }
}

/// How a call reaches the host: through the run's conversation, which only an async run has.
#[derive(Clone)]
struct Asker {
    talk: Option<Arc<Talk>>,
}

impl Asker {
    async fn ask<T: DeserializeOwned>(&self, op: &str, args: impl Serialize) -> Result<T, Fault> {
        let talk = self.talk.as_ref().ok_or_else(|| Fault::new(format!("{op} needs an answer, so only an `async fn` system may ask it")))?;
        talk.ask(op, args).await
    }
}

/// What `run` answers.
#[derive(Debug, Clone, Deserialize)]
pub struct RunResult {
    pub ok: bool,
    #[serde(default)]
    pub value: Value,
    pub stdout: Vec<String>,
    pub error: Option<RunError>,
    #[serde(default)]
    pub denials: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunError {
    pub kind: String,
    pub message: String,
}

/// A private cache, rebuilt from the session when lost; and the session's own record.
pub struct Store {
    asker: Asker,
}

impl Store {
    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, Fault> {
        self.asker.ask("store.get", json!({ "key": key })).await
    }

    pub async fn set(&self, key: &str, value: impl Serialize) -> Result<(), Fault> {
        let value = serde_json::to_value(value)?;
        self.asker.ask::<Value>("store.set", json!({ "key": key, "value": value })).await.map(|_| ())
    }

    /// Every entry this session after `after`, in order.
    pub async fn session(&self, after: Option<u64>) -> Result<Vec<Value>, Fault> {
        let args = match after {
            Some(after) => json!({ "after": after }),
            None => json!({}),
        };
        self.asker.ask("store.session", args).await
    }
}

/// Readable material the mind consults and maintains, published with the agent.
pub struct Knowledge {
    asker: Asker,
}

impl Knowledge {
    pub async fn list(&self, matching: Option<&str>, limit: Option<usize>) -> Result<Vec<Value>, Fault> {
        let mut args = json!({});
        if let Some(matching) = matching {
            args["match"] = Value::from(matching);
        }
        if let Some(limit) = limit {
            args["limit"] = Value::from(limit);
        }
        self.asker.ask("knowledge.list", args).await
    }

    pub async fn read(&self, name: &str) -> Result<String, Fault> {
        self.asker.ask("knowledge.read", json!({ "name": name })).await
    }

    pub async fn write(&self, name: &str, content: &str) -> Result<(), Fault> {
        self.asker.ask::<Value>("knowledge.write", json!({ "name": name, "content": content })).await.map(|_| ())
    }

    pub async fn remove(&self, name: &str) -> Result<(), Fault> {
        self.asker.ask::<Value>("knowledge.remove", json!({ "name": name })).await.map(|_| ())
    }
}

/// Where the mind's own databases live.
pub struct Memory {
    asker: Asker,
}

impl Memory {
    pub async fn connect(&self, name: &str) -> Result<Value, Fault> {
        self.asker.ask("memory.connect", json!({ "name": name })).await
    }
}

/// One output, built by kind and then its optional fields.
#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    kind: &'static str,
    data: Value,
}

impl Output {
    pub fn text(channel: &str, content: &str) -> Self {
        Self { kind: "text", data: json!({ "channel": channel, "content": content }) }
    }

    pub fn vector(channel: &str, values: &[f64]) -> Self {
        Self { kind: "vector", data: json!({ "channel": channel, "values": values }) }
    }

    pub fn audio(channel: &str, uri: &str, mime: &str) -> Self {
        Self { kind: "audio", data: json!({ "channel": channel, "ref": { "uri": uri, "mime": mime } }) }
    }

    pub fn visual(channel: &str, uri: &str, mime: &str, kind: &str) -> Self {
        Self { kind: "visual", data: json!({ "channel": channel, "ref": { "uri": uri, "mime": mime }, "kind": kind }) }
    }

    /// The `sensed` stamp of the newest reading this command was decided on.
    pub fn basis(self, sensed: f64) -> Self {
        self.with("basis", Value::from(sensed))
    }

    pub fn unit(self, unit: &str) -> Self {
        self.with("unit", Value::from(unit))
    }

    pub fn units(self, units: &[&str]) -> Self {
        self.with("units", Value::from(units.to_vec()))
    }

    pub fn labels(self, labels: &[&str]) -> Self {
        self.with("labels", Value::from(labels.to_vec()))
    }

    pub fn profile(self, profile: &str) -> Self {
        self.with("profile", Value::from(profile))
    }

    pub fn format(self, format: &str) -> Self {
        self.with("format", Value::from(format))
    }

    pub fn transcript(self, text: &str) -> Self {
        self.with("transcript", Value::from(text))
    }

    pub fn caption(self, text: &str) -> Self {
        self.with("caption", Value::from(text))
    }

    /// Part `of` a longer output; `last` closes it.
    pub fn chunk(self, of: &str, last: bool) -> Self {
        let chunk = if last { json!({ "of": of, "final": true }) } else { json!({ "of": of }) };
        self.with("chunk", chunk)
    }

    fn with(mut self, key: &str, value: Value) -> Self {
        self.data[key] = value;
        self
    }
}

thread_local! {
    /// The last state the runtime handed this module, on this thread: it sends state only when it changes.
    static STATE: RefCell<Option<Arc<State>>> = const { RefCell::new(None) };
}

/// The state a run sees: what it was sent, or the last one this module was sent. Read on the thread the
/// runtime calls in on; an async run's thread is handed it.
pub(crate) fn state(sent: Option<State>) -> Option<Arc<State>> {
    STATE.with(|cell| {
        if let Some(sent) = sent {
            *cell.borrow_mut() = Some(Arc::new(sent));
        }
        cell.borrow().clone()
    })
}

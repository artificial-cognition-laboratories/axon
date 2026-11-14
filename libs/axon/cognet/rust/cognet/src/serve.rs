//! Serving — how the compiled module answers the runtime: every system's
//! declaration, and one run at a time.

use std::future::Future;
use std::pin::Pin;

use crate::run::{Ran, Run, Snapshot};
use crate::{Declaration, Fault};

/// One run of an `async fn` system: its future, borrowing the run.
pub type AsyncRun = for<'a> fn(&'a mut Run) -> Pin<Box<dyn Future<Output = Result<(), Fault>> + 'a>>;

/// How a system runs: in the tick, or beside it in a conversation with the host.
#[derive(Clone, Copy)]
pub enum Body {
    Sync(fn(&mut Run) -> Result<(), Fault>),
    Async(AsyncRun),
}

/// One system the compiled module holds: its name (its path), its declaration, how it runs.
pub struct Served {
    pub name: &'static str,
    pub declare: fn() -> Declaration,
    pub body: Body,
}

/// Every system's declaration, by name — what the module answers `declarations()` with.
pub fn declarations(systems: &[Served]) -> Vec<(&'static str, Declaration)> {
    systems.iter().map(|system| (system.name, (system.declare)())).collect()
}

/// One run of the system named `name` against `snapshot`: what it wrote, or
/// why it failed. A panic is caught here, inside Rust — it cannot unwind
/// into the JavaScript calling it, which would abort the whole process — and
/// becomes a fault naming where it happened.
pub fn serve(systems: &[Served], name: &str, snapshot: Snapshot) -> Result<Ran, Fault> {
    let system = systems.iter().find(|system| system.name == name).ok_or_else(|| Fault::new(format!("this module holds no system \"{name}\" — the bundle and the native module were built from different sources")))?;
    let Body::Sync(body) = system.body else { return Err(Fault::new(format!("{name} is async — it runs in a conversation (`tell`), not in the tick"))) };
    panics::quiet();
    let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut run = Run::new(snapshot);
        body(&mut run).map(|()| run.finish())
    }));
    match ran {
        Ok(result) => result,
        Err(payload) => Err(Fault::new(format!("{name} panicked: {}", panics::said(payload)))),
    }
}

/// Panics, held for the fault instead of printed — for serving, here and in a conversation.
pub(crate) mod panics {
    use std::cell::RefCell;
    use std::sync::Once;

    thread_local! {
        /// Where the last panic on this thread happened.
        static WHERE: RefCell<Option<String>> = const { RefCell::new(None) };
    }

    /// Panics stop printing to stderr: what they say goes into the fault, with where they happened.
    pub fn quiet() {
        static HOOK: Once = Once::new();
        HOOK.call_once(|| {
            std::panic::set_hook(Box::new(|info| {
                let at = info.location().map(|location| format!("{}:{}", location.file(), location.line()));
                WHERE.with(|cell| *cell.borrow_mut() = at);
            }))
        });
    }

    /// What a panic said, and where.
    pub fn said(payload: Box<dyn std::any::Any + Send>) -> String {
        let message = payload.downcast_ref::<&str>().map(|text| text.to_string()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_else(|| "a panic with no message".to_string());
        match WHERE.with(|cell| cell.borrow_mut().take()) {
            Some(at) => format!("{message} (at {at})"),
            None => message,
        }
    }
}

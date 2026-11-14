//! cognet — what a cognet's Rust systems are written against.
//!
//! A Rust system is an ordinary system to everything outside it. The runtime
//! hands it an owned snapshot of what it DECLARED — the values it reads and
//! recalls, nothing else — and takes back what it wrote, as the same changes a
//! worker's reply carries; the world itself never crosses. So a system cannot
//! touch what it did not declare: it was never given it, and a write outside
//! its `writes` is refused where it lands.
//!
//! Values are the types generated from the cognet's schemas (`crate::schema`),
//! whose serde makes each one's JSON exactly the TypeScript value's. They
//! cross as JSON, each read into its type only when the system asks for it,
//! and every typed array beside the JSON as memory (`Array`, `Block`).
//!
//! ```ignore
//! use cognet::prelude::*;
//!
//! #[system(on = [clock], recalls = [PACE], writes = [RHYTHM])]
//! fn strike(run: &mut Run) -> Result<(), Fault> {
//!     let paced = run.ecs.first(PACE)?;
//!     run.ecs.set(SELF).put(RHYTHM, rates(paced))?;
//!     Ok(())
//! }
//! ```

use std::fmt;
use std::marker::PhantomData;

pub use cognet_macros::system;
pub use serde;
use serde::Serialize;

mod array;
mod kernel;
mod run;
mod serve;
mod services;
mod stimulus;
mod talk;

/// The version of the run protocol this crate speaks — the snapshot it reads
/// and the reply it writes. The runtime declares its own (`PROTOCOL` in
/// `@arcforge/cognet`) and refuses a module whose number differs, so a module
/// built against another runtime fails at load, never on every run.
pub const PROTOCOL: u32 = 3;

pub use array::{Array, Block, Element};
pub use kernel::{Effect, Kernel, Knowledge, Memory, Output, RunError, RunResult, State, Store, Surface, SURFACE};
pub use run::{Change, Ecs, Ran, Run, Set, Snapshot, Streams, Written};
pub use stimulus::{AudioStimulus, Ref, Stimulus, TextStimulus, Time, VectorStimulus, VisualStimulus};
pub use serve::{declarations, serve, Body, Served};
pub use services::{Handle, ServiceSession, ServiceState, Services, Use};
pub use talk::{tell, Events, Out};

/// What a system file needs in one import.
pub mod prelude {
    pub use crate::{clock, stimuli, system, Array, Component, Fault, Frame, Output, Run, Stimulus};
}

// ── handles ─────────────────────────────────────────────────────────────────

/// A component: its name, and the type its values have. Generated from the
/// schemas — a system never writes one — so the name cannot drift from the
/// declaration and a value of the wrong type does not compile.
pub struct Component<T> {
    name: &'static str,
    of: PhantomData<fn() -> T>,
}

impl<T> Component<T> {
    pub const fn new(name: &'static str) -> Self {
        Self { name: name, of: PhantomData }
    }

    /// Its full name, as the schema names it: `"control/pace"`.
    pub const fn name(&self) -> &'static str {
        self.name
    }
}

impl<T> Clone for Component<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Component<T> {}

/// A generated handle or a component name used by a system.
pub trait ComponentKey<T> {
    fn key(&self) -> &str;
}

impl<T> ComponentKey<T> for Component<T> {
    fn key(&self) -> &str { self.name }
}

impl<T> ComponentKey<T> for &str {
    fn key(&self) -> &str { self }
}

/// A frame: a space beliefs are placed in, by its full name — and the entity
/// a sensor's own beliefs are held on is its frame's name.
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    name: &'static str,
}

impl Frame {
    pub const fn new(name: &'static str) -> Self {
        Self { name: name }
    }

    /// Its full name, as the schema names it: `"sense/L0-measure/body"`.
    pub const fn name(&self) -> &'static str {
        self.name
    }
}


/// A framework input a system may be run by or read: `clock`, `stimuli`.
#[derive(Clone, Copy)]
pub struct Input {
    name: &'static str,
}

/// Run every tick — for what must notice time passing.
#[allow(non_upper_case_globals)]
pub const clock: Input = Input { name: "clock" };

/// Every stimulus since the system last ran. Main thread only.
#[allow(non_upper_case_globals)]
pub const stimuli: Input = Input { name: "stimuli" };

/// Anything a declaration names: a component, or an input.
pub trait Named {
    fn name(&self) -> &'static str;
}

impl<T> Named for Component<T> {
    fn name(&self) -> &'static str {
        self.name
    }
}

impl Named for Input {
    fn name(&self) -> &'static str {
        self.name
    }
}

// ── declaration ─────────────────────────────────────────────────────────────

/// What a system declares — what `defineSystem` takes, by name. `#[system]`
/// writes it; the build reads it from the compiled module and hands it to
/// the schedule, which checks it with every other system's.
#[derive(Debug, Clone, Serialize)]
pub struct Declaration {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<Vec<&'static str>>,
    pub reads: Vec<&'static str>,
    /// Read as every value written since it last ran — `run.since(HANDLE)`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub streams: Vec<&'static str>,
    pub recalls: Vec<&'static str>,
    pub writes: Vec<&'static str>,
    /// The services it calls, by the names the cognet gave them in `uses:`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub uses: Vec<&'static str>,
    pub once: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<&'static str>,
    /// Ticks from when a run starts to when its writes land; absent, the tick it ran in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lag: Option<u32>,
    /// An `async fn`: it runs beside the tick on its own thread, and may ask the kernel things.
    #[serde(rename = "async", skip_serializing_if = "std::ops::Not::not")]
    pub asynchronous: bool,
}

// ── faults ──────────────────────────────────────────────────────────────────

/// Why a run failed. Becomes `cognet:system:failed`, as a thrown error does. A refusal the
/// kernel answered a call with keeps the kernel's code (`AX-KNOWLEDGE-001`), so it can be matched.
#[derive(Debug, Clone)]
pub struct Fault {
    message: String,
    code: Option<String>,
}

impl Fault {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None }
    }

    /// A refusal with the kernel's structured code.
    pub fn coded(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { message: message.into(), code: Some(code.into()) }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// The kernel's code, when the kernel refused a call.
    pub fn code(&self) -> Option<&str> {
        self.code.as_deref()
    }
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Fault {}

impl From<serde_json::Error> for Fault {
    fn from(cause: serde_json::Error) -> Self {
        Self::new(format!("a value did not match its schema: {cause}"))
    }
}

// ── generated code's helpers ────────────────────────────────────────────────

/// Serde for a field that may be absent AND may be null — `x?: T | null` —
/// held as `Option<Option<T>>`: absent is `None`, null is `Some(None)`.
/// Used with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
pub mod absent_or_null {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer, T: Serialize>(value: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

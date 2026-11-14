//! A run — what the runtime hands a system, and what it takes back.

use std::collections::BTreeMap;
use std::rc::Rc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::array::{scope, Block};
use crate::kernel::{self, Effect, Kernel, State};
use crate::services::Services;
use crate::talk::Talk;
use std::sync::Arc;
use crate::stimulus::Stimulus;
use crate::{Component, ComponentKey, Fault};

/// What the runtime hands a run: the tick's time, every entity, each
/// declared component's values, `[component, entity, value]` — each value
/// still JSON, read into its type only when the system asks for it — every
/// component it streams with each value written since it last ran,
/// `[component, [[entity, value, at], ...]]`, and the blocks its arrays are
/// held in.
#[derive(Debug)]
pub struct Snapshot {
    pub now: f64,
    pub entities: Vec<String>,
    pub entries: Vec<(String, String, Box<RawValue>)>,
    pub reads: Vec<String>,
    pub writes: Vec<String>,
    pub streams: Vec<(String, Vec<(String, Box<RawValue>, f64)>)>,
    /// Every stimulus since it last ran, when it reads them.
    pub stimuli: Vec<Stimulus>,
    /// The kernel's state, when it changed since this module last saw it.
    pub state: Option<State>,
    pub blocks: Vec<Block>,
}

impl Snapshot {
    /// A snapshot as it crosses: `{ now, entities, entries }` as JSON, and the blocks its markers name.
    pub fn parse(json: &str, blocks: Vec<Block>) -> Result<Self, Fault> {
        #[derive(Deserialize)]
        struct Wire {
            now: f64,
            entities: Vec<String>,
            entries: Vec<(String, String, Box<RawValue>)>,
            reads: Vec<String>,
            writes: Vec<String>,
            /// Absent from a runtime that streams nothing.
            #[serde(default)]
            streams: Vec<(String, Vec<(String, Box<RawValue>, f64)>)>,
            /// Absent for a system that does not read stimuli.
            #[serde(default)]
            stimuli: Vec<serde_json::Value>,
            /// Absent when it has not changed, and on a worker.
            #[serde(default)]
            state: Option<State>,
        }
        let wire: Wire = serde_json::from_str(json).map_err(|cause| Fault::new(format!("the runtime sent a snapshot this module cannot read: {cause}")))?;
        let stimuli = wire.stimuli.iter().map(Stimulus::read).collect::<Result<Vec<_>, _>>()?;
        Ok(Self { now: wire.now, entities: wire.entities, entries: wire.entries, reads: wire.reads, writes: wire.writes, streams: wire.streams, stimuli: stimuli, state: wire.state, blocks: blocks })
    }

    /// A snapshot at `now` holding nothing — what a test builds on with `hold` and `stream`.
    pub fn at(now: f64) -> Self {
        Self { now: now, entities: Vec::new(), entries: Vec::new(), reads: Vec::new(), writes: Vec::new(), streams: Vec::new(), stimuli: Vec::new(), state: None, blocks: Vec::new() }
    }

    /// The snapshot with `component` streamed: these values written since the run before, `(entity, value, at)`, in
    /// order — none at all is a stream with nothing new, which is not the same as no stream.
    pub fn stream<T: Serialize>(mut self, component: Component<T>, written: Vec<(&str, T, f64)>) -> Result<Self, Fault> {
        let mut list = Vec::with_capacity(written.len());
        for (entity, value, at) in written {
            let raw = scope::writing(&mut self.blocks, || serde_json::value::to_raw_value(&value))?;
            list.push((entity.to_string(), raw, at));
        }
        self.streams.push((component.name().to_string(), list));
        Ok(self)
    }

    /// The snapshot with `entity` holding `value` as `component` — its arrays set aside as blocks, as they would cross.
    pub fn hold<T: Serialize>(mut self, entity: &str, component: Component<T>, value: T) -> Result<Self, Fault> {
        let raw = scope::writing(&mut self.blocks, || serde_json::value::to_raw_value(&value))?;
        if !self.entities.iter().any(|known| known == entity) {
            self.entities.push(entity.to_string());
        }
        self.entries.push((component.name().to_string(), entity.to_string(), raw));
        if !self.reads.iter().any(|name| name == component.name()) { self.reads.push(component.name().to_string()); }
        Ok(self)
    }

    /// Grant a test snapshot the same write permission a runtime declaration supplies.
    pub fn writable<T>(mut self, component: Component<T>) -> Self {
        self.writes.push(component.name().to_string());
        self
    }
}

/// One change a run made: what a worker's reply carries. `data` is JSON, its arrays markers into the run's blocks.
#[derive(Debug, Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Change {
    Set { entity: String, component: String, data: Box<RawValue> },
    Remove { entity: String, component: String },
}

/// Everything a run did, as it crosses back: its changes, the effects it asked for, and the blocks their markers name.
#[derive(Debug)]
pub struct Ran {
    pub changes: Vec<Change>,
    pub effects: Vec<Effect>,
    pub blocks: Vec<Block>,
}

impl Ran {
    /// `{ changes, effects }` as JSON — what the runtime parses, its markers resolving to `blocks`.
    pub fn json(&self) -> Result<String, Fault> {
        #[derive(Serialize)]
        struct Wire<'a> {
            changes: &'a [Change],
            effects: &'a [Effect],
        }
        Ok(serde_json::to_string(&Wire { changes: &self.changes, effects: &self.effects })?)
    }

    /// The same JSON, and the blocks it marks — what an async run says when it is done.
    pub fn json_with_blocks(self) -> Result<(String, Vec<Block>), Fault> {
        let json = self.json()?;
        Ok((json, self.blocks))
    }
}

/// One value written to a streamed component: who it was written on, the value, and when (epoch ms).
#[derive(Debug, Clone, PartialEq)]
pub struct Written<T> {
    pub entity: String,
    pub value: T,
    pub at: f64,
}

/// A run: the tick's time, and the world as the system declared it.
pub struct Run {
    pub now: f64,
    pub ecs: Ecs,
    /// What it streams, by component: every value written since it last ran.
    pub events: Streams,
    /// Every stimulus since it last ran, oldest first — empty unless it reads `stimuli`.
    pub stimuli: Vec<Stimulus>,
    /// Effects it asks for, and the state the body was in when it began.
    pub kernel: Kernel,
    /// The services it uses, by the names the cognet gave them.
    pub services: Services,
}

/// Values streamed since the previous run, independent of the ECS borrow.
pub struct Streams {
    values: BTreeMap<String, Vec<(String, Box<RawValue>, f64)>>,
    blocks: Rc<[Block]>,
}

impl Streams {
    pub fn since<T: DeserializeOwned>(&self, component: Component<T>) -> Result<Vec<Written<T>>, Fault> {
        let written = self.values.get(component.name()).ok_or_else(|| Fault::new(format!("asked for every write to {} without declaring it in streams", component.name())))?;
        written.iter().map(|(entity, value, at)| {
            let decoded = scope::reading(&self.blocks, || serde_json::from_str(value.get())).map_err(|cause| Fault::new(format!("{} did not match its schema: {cause}", component.name())))?;
            Ok(Written { entity: entity.clone(), value: decoded, at: *at })
        }).collect()
    }
}

impl Run {
    /// The run a snapshot describes, its kernel's state the one this module was last sent.
    pub fn new(mut snapshot: Snapshot) -> Self {
        let state = kernel::state(snapshot.state.take());
        Self::with(snapshot, state, None)
    }

    /// An async run: its state handed over from the thread the host called in on, and a conversation to ask through.
    pub(crate) fn talking(snapshot: Snapshot, state: Option<Arc<State>>, talk: Arc<Talk>) -> Self {
        Self::with(snapshot, state, Some(talk))
    }

    fn with(snapshot: Snapshot, state: Option<Arc<State>>, talk: Option<Arc<Talk>>) -> Self {
        let mut held: BTreeMap<String, Vec<(String, Box<RawValue>)>> = BTreeMap::new();
        for (component, entity, value) in snapshot.entries {
            held.entry(component).or_default().push((entity, value));
        }
        let blocks: Rc<[Block]> = snapshot.blocks.into();
        let ecs = Ecs { entities: snapshot.entities, held: held, readable: snapshot.reads, writable: snapshot.writes, read: blocks.clone(), changes: Vec::new(), written: Vec::new() };
        let events = Streams { values: snapshot.streams.into_iter().collect(), blocks: blocks };
        let services = Services { state: state.clone(), talk: talk.clone() };
        Self { now: snapshot.now, ecs: ecs, events: events, stimuli: snapshot.stimuli, kernel: Kernel::new(state, talk), services: services }
    }

    /// Every value written to `component` since this system last ran, oldest first. A component it does not declare
    /// in `streams` is a fault, not an empty list.
    pub fn since<T: DeserializeOwned>(&self, component: Component<T>) -> Result<Vec<Written<T>>, Fault> {
        self.events.since(component)
    }

    /// What it wrote, in order.
    pub fn finish(self) -> Ran {
        Ran { changes: self.ecs.changes, effects: self.kernel.finish(), blocks: self.ecs.written }
    }
}

/// The world, as a system declared it: read by component, written by entity.
pub struct Ecs {
    entities: Vec<String>,
    held: BTreeMap<String, Vec<(String, Box<RawValue>)>>,
    readable: Vec<String>,
    writable: Vec<String>,
    /// The blocks the values it was handed refer to.
    read: Rc<[Block]>,
    changes: Vec<Change>,
    /// The blocks its changes refer to.
    written: Vec<Block>,
}

impl Ecs {
    /// Every entity holding something this run declared.
    pub fn entities(&self) -> &[String] {
        &self.entities
    }

    /// One entity's value of a component; `None` where it holds none.
    pub fn get<T: DeserializeOwned>(&self, entity: &str, component: impl ComponentKey<T>) -> Result<Option<T>, Fault> {
        let name = self.resolve(component.key(), &self.readable, "read")?;
        match self.rows(name).iter().find(|(id, _)| id == entity) {
            Some((_, value)) => self.decode_name(name, value).map(Some),
            None => Ok(None),
        }
    }

    /// The first entity's value of a component, in the world's order — for a
    /// component one entity holds; `None` where none does.
    pub fn first<T: DeserializeOwned>(&self, component: impl ComponentKey<T>) -> Result<Option<T>, Fault> {
        let name = self.resolve(component.key(), &self.readable, "read")?;
        match self.rows(name).first() {
            Some((_, value)) => self.decode_name(name, value).map(Some),
            None => Ok(None),
        }
    }

    /// Every entity holding a component, with its value.
    pub fn all<T: DeserializeOwned>(&self, component: impl ComponentKey<T>) -> Result<Vec<(String, T)>, Fault> {
        let name = self.resolve(component.key(), &self.readable, "read")?;
        self.rows(name).iter().map(|(id, value)| Ok((id.clone(), self.decode_name(name, value)?))).collect()
    }

    /// Writes to one entity.
    pub fn set(&mut self, entity: &str) -> Set<'_> {
        Set { ecs: self, entity: entity.to_string() }
    }

    fn rows(&self, name: &str) -> &[(String, Box<RawValue>)] {
        self.held.get(name).map(Vec::as_slice).unwrap_or(&[])
    }

    /// A value read into its type, its markers resolving to this run's blocks. A value its schema does not describe names the component.
    fn decode_name<T: DeserializeOwned>(&self, name: &str, value: &RawValue) -> Result<T, Fault> {
        scope::reading(&self.read, || serde_json::from_str(value.get())).map_err(|cause| Fault::new(format!("{name} did not match its schema: {cause}")))
    }

    fn resolve<'a>(&self, key: &str, allowed: &'a [String], operation: &str) -> Result<&'a str, Fault> {
        if let Some(name) = allowed.iter().find(|name| name.as_str() == key) { return Ok(name); }
        let mut matches = allowed.iter().filter(|name| name.rsplit('/').next() == Some(key));
        match (matches.next(), matches.next()) {
            (Some(name), None) => Ok(name),
            (None, _) => Err(Fault::new(format!("{operation} of {key} without declaring that component"))),
            _ => Err(Fault::new(format!("{operation} of {key} is ambiguous; use its full name"))),
        }
    }
}

/// Writes to one entity, chained: `run.ecs.set(SELF).put(A, a)?.put(B, b)?`.
pub struct Set<'a> {
    ecs: &'a mut Ecs,
    entity: String,
}

impl<'a> Set<'a> {
    /// The entity holds `value` as `component`.
    pub fn put<T: Serialize>(self, component: impl ComponentKey<T>, value: T) -> Result<Self, Fault> {
        let name = self.ecs.resolve(component.key(), &self.ecs.writable, "write")?.to_string();
        let data = scope::writing(&mut self.ecs.written, || serde_json::value::to_raw_value(&value))?;
        self.ecs.changes.push(Change::Set { entity: self.entity.clone(), component: name, data: data });
        Ok(self)
    }

    /// The entity no longer holds `component`.
    pub fn remove<T>(self, component: impl ComponentKey<T>) -> Result<Self, Fault> {
        let name = self.ecs.resolve(component.key(), &self.ecs.writable, "write")?.to_string();
        self.ecs.changes.push(Change::Remove { entity: self.entity.clone(), component: name });
        Ok(self)
    }
}

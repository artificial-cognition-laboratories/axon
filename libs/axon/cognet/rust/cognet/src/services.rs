//! Services — what the mind needs from outside itself, by the names it gave
//! them in `uses:`. Each use is filled, or not, by whatever the agent granted;
//! the mind never learns which provider answered.
//!
//! `available` and `describe` are state, as they stood when the run began.
//! Calls, streams and sessions need an answer, so only an `async fn` system
//! makes them. Letting a handle go and closing a session are effects: they
//! need no answer.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};

use crate::kernel::{Effect, State};
use crate::talk::{self, Events, Talk};
use crate::Fault;

/// One use, as the runtime sent it: whether something fills it, and what that reports of itself.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ServiceState {
    pub available: bool,
    pub describe: Option<Value>,
}

/// Every use the cognet declared, by name.
pub struct Services {
    pub(crate) state: Option<Arc<State>>,
    pub(crate) talk: Option<Arc<Talk>>,
}

impl Services {
    /// A use, by the name the cognet gave it. A name it never declared is a fault.
    pub fn get(&self, name: &str) -> Result<Use, Fault> {
        let held = self.state.as_deref().ok_or_else(|| Fault::new("this run has no kernel state — a worker system has no services"))?;
        let state = held.services.get(name).ok_or_else(|| Fault::new(format!("{name} is no use this cognet declares in uses")))?;
        Ok(Use { name: name.to_string(), state: state.clone(), talk: self.talk.clone() })
    }
}

/// One use: its state as the run began, and its interface's methods by name.
pub struct Use {
    name: String,
    state: ServiceState,
    talk: Option<Arc<Talk>>,
}

impl Use {
    /// Whether something fills it. Ask before calling an optional one.
    pub fn available(&self) -> bool {
        self.state.available
    }

    /// What the granted provider reports of itself, as its interface defines it — `None` while unavailable.
    pub fn describe<T: DeserializeOwned>(&self) -> Result<Option<T>, Fault> {
        self.state.describe.clone().map(|value| serde_json::from_value(value).map_err(|cause| Fault::new(format!("{} described itself unlike its interface: {cause}", self.name)))).transpose()
    }

    /// A call: its arguments by the method's parameter names, one answer.
    pub async fn call<T: DeserializeOwned>(&self, method: &str, args: impl Serialize) -> Result<T, Fault> {
        self.talk()?.ask("service.call", Asked { name: &self.name, method: method, args: args }).await
    }

    /// A stream: each answer as it comes. Dropping it before the end tells the host to stop.
    pub fn stream<T: DeserializeOwned>(&self, method: &str, args: impl Serialize) -> Result<Events<T>, Fault> {
        self.talk()?.stream("service.stream", Asked { name: &self.name, method: method, args: args })
    }

    /// Opens a session: pushes that share state, until it is closed.
    pub async fn open(&self, method: &str) -> Result<ServiceSession, Fault> {
        let id: String = self.talk()?.ask("service.open", json!({ "use": self.name, "method": method })).await?;
        Ok(ServiceSession { id: id, talk: self.talk()?.clone() })
    }

    fn talk(&self) -> Result<&Arc<Talk>, Fault> {
        self.talk.as_ref().ok_or_else(|| Fault::new(format!("{} needs an answer, so only an `async fn` system may call it", self.name)))
    }
}

/// Pushes that share state, each answered in order.
pub struct ServiceSession {
    id: String,
    talk: Arc<Talk>,
}

impl ServiceSession {
    pub async fn push<T: DeserializeOwned>(&self, value: impl Serialize) -> Result<T, Fault> {
        self.talk.ask("service.push", Pushed { session: &self.id, value: value }).await
    }

    /// Starts again, as if just opened.
    pub fn reset(&self) -> Result<(), Fault> {
        self.talk.effect(&Effect { verb: "reset", args: json!({ "session": self.id }) })
    }

    pub fn close(self) -> Result<(), Fault> {
        self.talk.effect(&Effect { verb: "close", args: json!({ "session": self.id }) })
    }
}

/// Something a provider keeps — an encoded picture, a loaded scene — crossing only as its id. Pass it back to the
/// use that made it; release it when done.
#[derive(Debug, Clone, PartialEq)]
pub struct Handle {
    pub name: String,
    pub id: String,
}

impl Handle {
    /// Lets it go. Made through the conversation of the run this thread is running.
    pub fn release(&self) -> Result<(), Fault> {
        let talk = talk::current().ok_or_else(|| Fault::new("a handle is released from the async run that holds it"))?;
        talk.effect(&Effect { verb: "release", args: json!({ "handle": self.id }) })
    }
}

/// What a call asks, serialized where the conversation sets its arrays aside — never through a `Value`, which would
/// turn an array into a list of numbers.
#[derive(Serialize)]
struct Asked<'a, A: Serialize> {
    #[serde(rename = "use")]
    name: &'a str,
    method: &'a str,
    args: A,
}

#[derive(Serialize)]
struct Pushed<'a, V: Serialize> {
    session: &'a str,
    value: V,
}

#[derive(Serialize, Deserialize)]
struct Wire {
    handle: String,
    id: String,
}

impl Serialize for Handle {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Wire { handle: self.name.clone(), id: self.id.clone() }.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Handle {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = Wire::deserialize(deserializer)?;
        Ok(Handle { name: wire.handle, id: wire.id })
    }
}

/// The services state, keyed by use — what `State` carries.
pub type ServiceStates = BTreeMap<String, ServiceState>;

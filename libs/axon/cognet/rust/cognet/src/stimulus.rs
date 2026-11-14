//! Stimuli — what the body sensed since a system last ran, typed by kind.

use serde::Deserialize;
use serde_json::Value;

use crate::Fault;

/// When a stimulus arrived: wall-clock ms, and its place in the session.
#[derive(Debug, Clone, Copy, PartialEq, Default, Deserialize)]
pub struct Time {
    pub ms: f64,
    pub seq: u64,
}

/// Where a heavy payload's bytes are — never the bytes.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Ref {
    pub uri: String,
    pub mime: String,
    pub bytes: Option<u64>,
}

/// One reading, from one sense, on one channel.
#[derive(Debug, Clone, PartialEq)]
pub enum Stimulus {
    Text(TextStimulus),
    Audio(AudioStimulus),
    Visual(VisualStimulus),
    Vector(VectorStimulus),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TextStimulus {
    pub channel: String,
    pub content: String,
    pub format: Option<String>,
    /// From the envelope, beside the data.
    #[serde(skip)]
    pub time: Time,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStimulus {
    pub channel: String,
    #[serde(rename = "ref")]
    pub r#ref: Ref,
    pub transcript: Option<String>,
    pub duration_ms: Option<f64>,
    pub sensed: Option<f64>,
    /// From the envelope, beside the data.
    #[serde(skip)]
    pub time: Time,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct VisualStimulus {
    pub channel: String,
    #[serde(rename = "ref")]
    pub r#ref: Ref,
    pub kind: String,
    pub caption: Option<String>,
    pub sensed: Option<f64>,
    /// From the envelope, beside the data.
    #[serde(skip)]
    pub time: Time,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct VectorStimulus {
    pub channel: String,
    pub values: Vec<f64>,
    pub unit: Option<String>,
    pub units: Option<Vec<String>>,
    pub labels: Option<Vec<String>>,
    pub profile: Option<String>,
    pub sensed: Option<f64>,
    /// From the envelope, beside the data.
    #[serde(skip)]
    pub time: Time,
}

impl Stimulus {
    /// The channel it arrived on.
    pub fn channel(&self) -> &str {
        match self {
            Stimulus::Text(one) => &one.channel,
            Stimulus::Audio(one) => &one.channel,
            Stimulus::Visual(one) => &one.channel,
            Stimulus::Vector(one) => &one.channel,
        }
    }

    /// One stimulus as the runtime sends it: `{ type: "cognet:stimulus:<kind>", time, data }`.
    pub(crate) fn read(entry: &Value) -> Result<Self, Fault> {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(rename = "type")]
            kind: String,
            time: Time,
            data: Value,
        }
        let wire: Wire = serde_json::from_value(entry.clone()).map_err(|cause| Fault::new(format!("the runtime sent a stimulus this module cannot read: {cause}")))?;
        let unreadable = |cause: serde_json::Error| Fault::new(format!("{} did not match its kind: {cause}", wire.kind));
        let time = wire.time;
        match wire.kind.as_str() {
            "cognet:stimulus:text" => serde_json::from_value(wire.data).map(|one: TextStimulus| Stimulus::Text(TextStimulus { time: time, ..one })).map_err(unreadable),
            "cognet:stimulus:audio" => serde_json::from_value(wire.data).map(|one: AudioStimulus| Stimulus::Audio(AudioStimulus { time: time, ..one })).map_err(unreadable),
            "cognet:stimulus:visual" => serde_json::from_value(wire.data).map(|one: VisualStimulus| Stimulus::Visual(VisualStimulus { time: time, ..one })).map_err(unreadable),
            "cognet:stimulus:vector" => serde_json::from_value(wire.data).map(|one: VectorStimulus| Stimulus::Vector(VectorStimulus { time: time, ..one })).map_err(unreadable),
            other => Err(Fault::new(format!("the runtime sent a stimulus of kind {other}, which this module does not know"))),
        }
    }
}

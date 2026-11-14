//! Events, one JSON object per line on stderr. The daemon forwards them into its trace
//! log — a connection that quietly fell back to a relay is exactly what must be visible.

use serde_json::{json, Value};

pub fn event(name: &str, fields: Value) {
    let mut line = json!({ "event": name });
    if let (Some(line), Value::Object(fields)) = (line.as_object_mut(), fields) {
        line.extend(fields);
    }
    eprintln!("{line}");
}

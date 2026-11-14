//! An async system's conversation with the host, with no host: a real
//! `async fn` system started by `tell`, asking the kernel, answered, sending an
//! effect as it goes — and cancelled while it waits.

use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use cognet::prelude::*;
use cognet::{tell, Served};
use serde_json::{json, Value};

#[system(once, writes = ["seen"], uses = ["depth"])]
async fn look(run: &mut Run) -> Result<(), Fault> {
    let depth: Vec<f64> = run.services.get("depth")?.call("estimate", serde_json::json!({ "picture": [1.0, 2.0] })).await?;
    run.kernel.output(Output::text("/log", "asked"))?;
    ecs.set("self").put("seen", depth)?;
    Ok(())
}

static SYSTEMS: &[Served] = &[Served { name: "look", declare: __cognet_declare, body: __COGNET_BODY }];

mod chat {
    use cognet::prelude::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Written {
        text: String,
    }

    #[derive(Deserialize)]
    struct Depth {
        #[serde(rename = "maxSide")]
        max_side: u32,
    }

    /// Reads the services' state, and leaves a stream after its first answer.
    #[system(once, writes = ["seen"])]
    pub async fn chat(run: &mut Run) -> Result<(), Fault> {
        assert!(run.services.get("main")?.available() && !run.services.get("hear")?.available());
        assert_eq!(run.services.get("depth")?.describe::<Depth>()?.map(|one| one.max_side), Some(518));
        assert!(run.services.get("nothing").is_err());
        let main = run.services.get("main")?;
        let mut events = main.stream::<Written>("stream", serde_json::json!({ "conversation": { "messages": [{ "role": "user", "text": "hi" }] } }))?;
        let first = events.next().await.expect("an answer")?;
        drop(events);
        ecs.set("self").put("seen", vec![first.text])?;
        Ok(())
    }

    pub static SYSTEMS: &[cognet::Served] = &[cognet::Served { name: "look", declare: __cognet_declare, body: __COGNET_BODY }];
}

/// A host that only listens: every message the module says, in order.
fn host() -> (cognet::Out, mpsc::Receiver<Value>) {
    let (send, heard) = mpsc::channel();
    let out: cognet::Out = Arc::new(move |text: String| {
        send.send(serde_json::from_str(&text).unwrap()).unwrap();
    });
    (out, heard)
}

fn job(id: u64) -> String {
    let state = json!({ "rev": 1, "body": null, "presence": null, "scope": {}, "services": { "depth": { "available": true, "describe": null } } });
    let snapshot = json!({ "now": 0, "entities": [], "entries": [], "reads": [], "writes": ["seen"], "streams": [], "state": state }).to_string();
    json!({ "kind": "job", "job": id, "system": "look", "snapshot": snapshot, "kinds": [], "arrays": [] }).to_string()
}

fn next(heard: &mpsc::Receiver<Value>) -> Value {
    heard.recv_timeout(Duration::from_secs(5)).expect("the module said nothing")
}

#[test]
fn asks_is_answered_acts_and_finishes() {
    let (out, heard) = host();
    tell(SYSTEMS, &job(1), out.clone()).unwrap();

    let call = next(&heard);
    assert_eq!(call["kind"], "call");
    assert_eq!(call["op"], "service.call");
    assert_eq!(serde_json::from_str::<Value>(call["args"].as_str().unwrap()).unwrap(), json!({ "use": "depth", "method": "estimate", "args": { "picture": [1.0, 2.0] } }));

    let answer = json!({ "kind": "answer", "job": 1, "call": call["call"], "value": "[10.0, 20.0]", "kinds": [], "arrays": [] });
    tell(SYSTEMS, &answer.to_string(), out).unwrap();

    let effect = next(&heard);
    assert_eq!(effect["kind"], "effect");
    let done = next(&heard);
    assert_eq!(done["kind"], "done");
    let ran: Value = serde_json::from_str(done["ran"].as_str().unwrap()).unwrap();
    assert_eq!(ran["changes"][0]["data"], json!([10.0, 20.0]));
}

#[test]
fn a_refused_call_fails_the_run_with_the_kernel_code() {
    let (out, heard) = host();
    tell(SYSTEMS, &job(2), out.clone()).unwrap();
    let call = next(&heard);
    let refused = json!({ "kind": "answer", "job": 2, "call": call["call"], "error": { "code": "AX-SERVICE-001", "message": "depth is not available" } });
    tell(SYSTEMS, &refused.to_string(), out).unwrap();
    let said = next(&heard);
    assert_eq!(said["kind"], "error");
    assert!(said["error"].as_str().unwrap().contains("depth is not available"));
}

#[test]
fn a_cancelled_run_says_so_and_never_finishes() {
    let (out, heard) = host();
    tell(SYSTEMS, &job(3), out.clone()).unwrap();
    assert_eq!(next(&heard)["kind"], "call");
    tell(SYSTEMS, &json!({ "kind": "cancel", "job": 3 }).to_string(), out).unwrap();
    assert_eq!(next(&heard)["kind"], "cancelled");
    assert!(heard.recv_timeout(Duration::from_millis(200)).is_err());
}

fn messages() -> Value {
    serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/contract/messages.json")).unwrap()).unwrap()
}

fn keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

/// Every message as `tests/contract/messages.json` pins it — what the runtime's own contract test speaks and hears.
#[test]
fn speaks_and_hears_the_pinned_conversation() {
    let pinned = messages();
    let (out, heard) = host();
    // Its own job number: the tests share one module's job table.
    let mut job = pinned["told"]["job"].clone();
    job["job"] = json!(100);
    tell(SYSTEMS, &job.to_string(), out.clone()).unwrap();

    let call = next(&heard);
    assert_eq!(keys(&call), keys(&pinned["said"]["call"]));
    assert_eq!(serde_json::from_str::<Value>(call["args"].as_str().unwrap()).unwrap(), serde_json::from_str::<Value>(pinned["said"]["call"]["args"].as_str().unwrap()).unwrap());

    let mut answer = pinned["told"]["answer"].clone();
    answer["job"] = json!(100);
    answer["call"] = call["call"].clone();
    tell(SYSTEMS, &answer.to_string(), out).unwrap();

    let effect = next(&heard);
    assert_eq!(keys(&effect), keys(&pinned["said"]["effect"]));
    assert_eq!(serde_json::from_str::<Value>(effect["effect"].as_str().unwrap()).unwrap(), serde_json::from_str::<Value>(pinned["said"]["effect"]["effect"].as_str().unwrap()).unwrap());
    let done = next(&heard);
    assert_eq!(keys(&done), keys(&pinned["said"]["done"]));
    assert_eq!(serde_json::from_str::<Value>(done["ran"].as_str().unwrap()).unwrap(), serde_json::from_str::<Value>(pinned["said"]["done"]["ran"].as_str().unwrap()).unwrap());
}

/// A streamed call as pinned: asked, each event heard as it comes, and stopped — before the run is done — when the
/// system leaves early.
#[test]
fn streams_a_service_and_stops_when_left() {
    let pinned = messages();
    let snapshot: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/contract/snapshot.json")).unwrap()).unwrap();
    let mut state = snapshot["state"].clone();
    state["services"]["main"] = json!({ "available": true, "describe": { "context": 200000 } });
    let mut job = pinned["told"]["job"].clone();
    job["job"] = json!(200);
    let mut sent: Value = serde_json::from_str(job["snapshot"].as_str().unwrap()).unwrap();
    sent["state"] = state;
    job["snapshot"] = json!(sent.to_string());
    let (out, heard) = host();
    tell(chat::SYSTEMS, &job.to_string(), out.clone()).unwrap();

    let call = next(&heard);
    assert_eq!(keys(&call), keys(&pinned["said"]["stream"]));
    assert_eq!(serde_json::from_str::<Value>(call["args"].as_str().unwrap()).unwrap(), serde_json::from_str::<Value>(pinned["said"]["stream"]["args"].as_str().unwrap()).unwrap());

    let mut event = pinned["told"]["event"].clone();
    event["job"] = json!(200);
    event["call"] = call["call"].clone();
    tell(chat::SYSTEMS, &event.to_string(), out).unwrap();

    let stop = next(&heard);
    assert_eq!(stop, json!({ "kind": "stop", "job": 200, "call": call["call"] }));
    let done = next(&heard);
    assert_eq!(done["kind"], "done");
    let ran: Value = serde_json::from_str(done["ran"].as_str().unwrap()).unwrap();
    assert_eq!(ran["changes"][0]["data"], json!(["Hel"]));
}

//! The run protocol, pinned on both sides by one set of files: the runtime's
//! `tests/hot/contract.test.ts` proves it SENDS `tests/contract/snapshot.json`
//! and LANDS `tests/contract/ran.json`; this proves the crate reads the one
//! and writes the other — so a field one side adds or drops fails a test,
//! never every run of every Rust system.

use cognet::{Array, Block, Component, Output, Run, Snapshot};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Count {
    at: f64,
    points: Array<f64>,
}

const COUNT: Component<Count> = Component::new("count");

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/../../tests/contract/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

#[test]
fn reads_the_snapshot_and_writes_the_reply_the_runtime_expects() {
    let snapshot = Snapshot::parse(&fixture("snapshot.json"), vec![Block::F64(vec![1.0, 2.0])]).unwrap();
    let mut run = Run::new(snapshot);

    assert_eq!(run.now, 1000.0);
    let held = run.ecs.first(COUNT).unwrap().unwrap();
    assert_eq!(held.at, 12.0);
    assert_eq!(held.points.clone().into_vec(), vec![1.0, 2.0]);
    assert_eq!(run.kernel.presence().unwrap().unwrap()["state"], "embodied");
    assert!(run.kernel.body().unwrap().is_none());

    run.ecs.set("self").put(COUNT, Count { at: 13.0, points: Array::new(vec![3.0]) }).unwrap();
    run.kernel.output(Output::vector("/wheels", &[0.4, 0.4]).basis(held.at)).unwrap();

    let ran = run.finish();
    let written: serde_json::Value = serde_json::from_str(&ran.json().unwrap()).unwrap();
    let expected: serde_json::Value = serde_json::from_str(&fixture("ran.json")).unwrap();
    assert_eq!(written, expected);
    assert!(matches!(&ran.blocks[..], [Block::F64(values)] if values == &vec![3.0]));
}

#[test]
fn keeps_the_state_it_was_sent_until_it_changes() {
    let first = Snapshot::parse(&fixture("snapshot.json"), vec![Block::F64(vec![1.0, 2.0])]).unwrap();
    drop(Run::new(first));
    // A later run is sent no state: it reads the state this module was last sent.
    let later = Snapshot::parse(r#"{"now":1050,"entities":[],"entries":[],"reads":[],"writes":[],"streams":[]}"#, vec![]).unwrap();
    let run = Run::new(later);
    assert_eq!(run.kernel.presence().unwrap().unwrap()["state"], "embodied");
}

#[test]
fn implements_the_kernel_surface_the_runtime_pins() {
    let pinned: serde_json::Value = serde_json::from_str(&fixture("verbs.json")).unwrap();
    let names = |list: &[&str]| serde_json::Value::from(list.to_vec());
    assert_eq!(pinned["effects"], names(cognet::SURFACE.effects));
    assert_eq!(pinned["state"], names(cognet::SURFACE.state));
    assert_eq!(pinned["calls"], names(cognet::SURFACE.calls));
}

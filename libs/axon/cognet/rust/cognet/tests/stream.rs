//! A streamed component reaches a run as every value written since it last
//! ran, with when each was written — arrays as blocks, as anywhere else — and
//! asking for a stream the system did not declare is a fault, never an empty
//! list that looks like nothing happened.

use cognet::prelude::*;
use cognet::{Snapshot, Written};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Sample {
    accel: Array<f64>,
}

const SAMPLE: Component<Sample> = Component::new("test/sample");
const POSE: Component<f64> = Component::new("test/pose");

fn sample(x: f64) -> Sample {
    Sample { accel: Array::new(vec![x, 0.0, -9.8]) }
}

#[test]
fn a_run_reads_every_value_written_since_it_last_ran_in_order_with_when() {
    let snapshot = Snapshot::at(100.0).stream(SAMPLE, vec![("body", sample(1.0), 50.0), ("body", sample(1.0), 75.0), ("body", sample(2.0), 100.0)]).unwrap();
    let run = Run::new(snapshot);
    let written = run.since(SAMPLE).unwrap();
    assert_eq!(written.iter().map(|one| (one.value.accel[0], one.at)).collect::<Vec<_>>(), vec![(1.0, 50.0), (1.0, 75.0), (2.0, 100.0)]);
    assert!(written.iter().all(|one| one.entity == "body"));
}

#[test]
fn a_stream_with_nothing_new_is_empty_and_an_undeclared_one_is_a_fault() {
    let run = Run::new(Snapshot::at(0.0).stream(SAMPLE, vec![]).unwrap());
    assert_eq!(run.since(SAMPLE).unwrap(), Vec::<Written<Sample>>::new());
    let refused = run.since(POSE).unwrap_err();
    assert!(refused.message().contains("without declaring it in streams"), "{}", refused.message());
}

#[test]
fn the_runtime_snapshot_carries_streams_and_one_without_them_still_reads() {
    let streamed = Snapshot::parse(r#"{"now":1,"entities":[],"entries":[],"reads":[],"writes":[],"streams":[["test/pose",[["self",2.5,10]]]]}"#, vec![]).unwrap();
    assert_eq!(Run::new(streamed).since(POSE).unwrap(), vec![Written { entity: "self".to_string(), value: 2.5, at: 10.0 }]);
    // An older runtime sends no streams at all; a system that streams nothing never notices.
    assert!(Snapshot::parse(r#"{"now":1,"entities":[],"entries":[],"reads":[],"writes":[]}"#, vec![]).unwrap().streams.is_empty());
}

#[system(streams = [SAMPLE], writes = [POSE], thread = "worker", lag = 2)]
fn integrate(run: &mut Run) -> Result<(), Fault> {
    let total: f64 = run.since(SAMPLE)?.iter().map(|one| one.value.accel[0]).sum();
    run.ecs.set("self").put(POSE, total)?;
    Ok(())
}

#[test]
fn a_system_declares_what_it_streams_and_its_lag() {
    let declared = serde_json::to_value(__cognet_declare()).unwrap();
    assert_eq!(declared["streams"], serde_json::json!(["test/sample"]));
    assert_eq!(declared["lag"], serde_json::json!(2));
    assert_eq!(declared["reads"], serde_json::json!([]));
}

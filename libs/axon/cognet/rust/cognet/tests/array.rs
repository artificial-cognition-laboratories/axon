//! Arrays cross as blocks of memory, never as JSON numbers — and a block of
//! the wrong kind, or a marker with nothing behind it, is a fault naming the
//! component, never a silently wrong value.

use cognet::{Array, Block, Change, Component, Run, Snapshot};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Cloud {
    cols: u32,
    points: Array<f64>,
}

const CLOUD: Component<Cloud> = Component::new("test/cloud");
const WIDE: Component<Array<f32>> = Component::new("test/wide");

fn cloud() -> Cloud {
    Cloud { cols: 2, points: Array::new(vec![1.0, f64::NAN, 3.5]) }
}

#[test]
fn a_held_array_is_a_block_and_its_marker() {
    let snapshot = Snapshot::at(0.0).hold("self", CLOUD, cloud()).unwrap();
    assert!(matches!(&snapshot.blocks[..], [Block::F64(values)] if values.len() == 3 && values[1].is_nan()));
    assert_eq!(snapshot.entries[0].2.get(), r#"{"cols":2,"points":{"$array":0}}"#);
}

#[test]
fn a_run_reads_the_block_back_as_its_array() {
    let run = Run::new(Snapshot::at(0.0).hold("self", CLOUD, cloud()).unwrap());
    let read = run.ecs.get("self", CLOUD).unwrap().unwrap();
    assert_eq!(read.cols, 2);
    assert_eq!(read.points[0], 1.0);
    assert!(read.points[1].is_nan());
}

#[test]
fn string_names_resolve_only_declared_components() {
    let run = Run::new(Snapshot::at(0.0).hold("self", CLOUD, cloud()).unwrap());
    assert_eq!(run.ecs.first::<Cloud>("cloud").unwrap().unwrap().cols, 2);
    assert!(run.ecs.first::<Cloud>("missing").unwrap_err().message().contains("without declaring"));
}

#[test]
fn a_write_sets_its_array_aside_as_a_block() {
    let mut run = Run::new(Snapshot::at(0.0).writable(CLOUD));
    run.ecs.set("self").put(CLOUD, cloud()).unwrap();
    let ran = run.finish();
    assert!(matches!(&ran.blocks[..], [Block::F64(values)] if values.len() == 3));
    assert!(matches!(&ran.changes[..], [Change::Set { data, .. }] if data.get() == r#"{"cols":2,"points":{"$array":0}}"#));
    assert_eq!(ran.json().unwrap(), r#"{"changes":[{"op":"set","entity":"self","component":"test/cloud","data":{"cols":2,"points":{"$array":0}}}],"effects":[]}"#);
}

#[test]
fn a_block_of_another_kind_is_a_fault_naming_the_component() {
    let mut snapshot = Snapshot::at(0.0).hold("self", WIDE, Array::new(vec![1.0_f32])).unwrap();
    snapshot.blocks[0] = Block::F64(vec![1.0]);
    let fault = Run::new(snapshot).ecs.get("self", WIDE).unwrap_err();
    assert!(fault.message().contains("test/wide"), "{}", fault.message());
    assert!(fault.message().contains("a block of f64 where f32 was declared"), "{}", fault.message());
}

#[test]
fn a_marker_with_no_block_is_a_fault() {
    let snapshot = Snapshot::parse(r#"{"now":0,"entities":["self"],"reads":["test/wide"],"writes":[],"entries":[["test/wide","self",{"$array":3}]]}"#, vec![]).unwrap();
    let fault = Run::new(snapshot).ecs.get("self", WIDE).unwrap_err();
    assert!(fault.message().contains("block 3 of 0"), "{}", fault.message());
}

#[test]
fn a_plain_list_is_an_array_too() {
    let snapshot = Snapshot::parse(r#"{"now":0,"entities":["self"],"reads":["test/wide"],"writes":[],"entries":[["test/wide","self",[1,2]]]}"#, vec![]).unwrap();
    assert_eq!(*Run::new(snapshot).ecs.get("self", WIDE).unwrap().unwrap(), [1.0_f32, 2.0]);
}

#[test]
fn a_block_is_read_from_a_typed_array_s_bytes() {
    let bytes: Vec<u8> = [1.5_f64, -2.0].iter().flat_map(|value| value.to_ne_bytes()).collect();
    assert_eq!(Block::from_bytes("f64", &bytes).unwrap(), Block::F64(vec![1.5, -2.0]));
    assert!(Block::from_bytes("f64", &bytes[..5]).unwrap_err().message().contains("no whole number"));
    assert!(Block::from_bytes("f16", &bytes).is_err());
}

#[test]
fn a_null_where_a_number_was_declared_names_the_component() {
    // JSON has no NaN outside a block: a NaN in a plain number crosses as null, and is refused loudly.
    let snapshot = Snapshot::parse(r#"{"now":0,"entities":["self"],"reads":["test/cloud"],"writes":[],"entries":[["test/cloud","self",{"cols":null,"points":[]}]]}"#, vec![]).unwrap();
    let fault = Run::new(snapshot).ecs.get("self", CLOUD).unwrap_err();
    assert!(fault.message().contains("test/cloud did not match its schema"), "{}", fault.message());
}

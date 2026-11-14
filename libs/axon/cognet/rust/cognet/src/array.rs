//! Arrays — numbers held as one block of memory, as a `Float64Array` is.
//!
//! A schema field marked `(cognet.array)` is an `Array<T>`. It never crosses
//! as JSON: where it sits in a value, the JSON says `{"$array": i}`, and the
//! `i`th block beside the JSON holds its numbers — copied once, as memory,
//! however many there are. Inside a run that is invisible: `ecs.get` hands
//! back an `Array<f64>` and `put` takes one. Outside one (a test, a value
//! printed) an array is a plain JSON list.

use std::cell::RefCell;
use std::fmt;
use std::marker::PhantomData;
use std::ops::{Deref, DerefMut};
use std::rc::Rc;

use serde::de::{self, DeserializeOwned, MapAccess, SeqAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::Fault;

/// The key a block's place in a value is marked with.
const MARKER: &str = "$array";

/// Numbers held as one block — a field the schema marks `(cognet.array)`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Array<T>(Vec<T>);

impl<T> Array<T> {
    pub fn new(values: Vec<T>) -> Self {
        Self(values)
    }

    pub fn into_vec(self) -> Vec<T> {
        self.0
    }
}

impl<T> From<Vec<T>> for Array<T> {
    fn from(values: Vec<T>) -> Self {
        Self(values)
    }
}

impl<T> FromIterator<T> for Array<T> {
    fn from_iter<I: IntoIterator<Item = T>>(values: I) -> Self {
        Self(values.into_iter().collect())
    }
}

impl<T> Deref for Array<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        &self.0
    }
}

impl<T> DerefMut for Array<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        &mut self.0
    }
}

/// A block as it crosses: its numbers, and what type they are.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    F64(Vec<f64>),
    F32(Vec<f32>),
    I32(Vec<i32>),
    U32(Vec<u32>),
    U8(Vec<u8>),
}

impl Block {
    /// A block from the bytes of a typed array, by the name its kind crosses as: `f64`, `f32`, `i32`, `u32`, `u8`.
    pub fn from_bytes(kind: &str, bytes: &[u8]) -> Result<Self, Fault> {
        fn each<T, const N: usize>(bytes: &[u8], kind: &str, read: fn([u8; N]) -> T) -> Result<Vec<T>, Fault> {
            if bytes.len() % N != 0 {
                return Err(Fault::new(format!("a block of {kind} is {} bytes long, which is no whole number of them", bytes.len())));
            }
            Ok(bytes.chunks_exact(N).map(|chunk| read(chunk.try_into().expect("chunks_exact gives N bytes"))).collect())
        }
        match kind {
            "f64" => each(bytes, kind, f64::from_ne_bytes).map(Block::F64),
            "f32" => each(bytes, kind, f32::from_ne_bytes).map(Block::F32),
            "i32" => each(bytes, kind, i32::from_ne_bytes).map(Block::I32),
            "u32" => each(bytes, kind, u32::from_ne_bytes).map(Block::U32),
            "u8" => Ok(Block::U8(bytes.to_vec())),
            other => Err(Fault::new(format!("a block of \"{other}\" — blocks hold f64, f32, i32, u32 or u8"))),
        }
    }

    /// Its numbers as the bytes of a typed array, in this machine's order — what `from_bytes` reads back.
    pub fn bytes(&self) -> Vec<u8> {
        match self {
            Block::F64(values) => values.iter().flat_map(|value| value.to_ne_bytes()).collect(),
            Block::F32(values) => values.iter().flat_map(|value| value.to_ne_bytes()).collect(),
            Block::I32(values) => values.iter().flat_map(|value| value.to_ne_bytes()).collect(),
            Block::U32(values) => values.iter().flat_map(|value| value.to_ne_bytes()).collect(),
            Block::U8(values) => values.clone(),
        }
    }

    /// The name its kind crosses as.
    pub fn kind(&self) -> &'static str {
        match self {
            Block::F64(_) => f64::KIND,
            Block::F32(_) => f32::KIND,
            Block::I32(_) => i32::KIND,
            Block::U32(_) => u32::KIND,
            Block::U8(_) => u8::KIND,
        }
    }
}

/// A number type a block can hold.
pub trait Element: Copy + fmt::Debug + PartialEq + Serialize + DeserializeOwned + 'static {
    const KIND: &'static str;
    fn block(values: Vec<Self>) -> Block;
    fn of(block: &Block) -> Option<&[Self]>;
}

macro_rules! element {
    ($type:ty, $kind:literal, $variant:ident) => {
        impl Element for $type {
            const KIND: &'static str = $kind;
            fn block(values: Vec<Self>) -> Block {
                Block::$variant(values)
            }
            fn of(block: &Block) -> Option<&[Self]> {
                match block {
                    Block::$variant(values) => Some(values),
                    _ => None,
                }
            }
        }
    };
}

element!(f64, "f64", F64);
element!(f32, "f32", F32);
element!(i32, "i32", I32);
element!(u32, "u32", U32);
element!(u8, "u8", U8);

thread_local! {
    /// The blocks a value being read refers to — set while `scope::reading` runs.
    static READING: RefCell<Option<Rc<[Block]>>> = const { RefCell::new(None) };
    /// The blocks a value being written has set aside — set while `scope::writing` runs.
    static WRITING: RefCell<Option<Vec<Block>>> = const { RefCell::new(None) };
}

/// Where a value's markers resolve while it is read or written — private to the run.
pub(crate) mod scope {
    use super::*;

    /// `read` run with markers resolving to `blocks`.
    pub fn reading<R>(blocks: &Rc<[Block]>, read: impl FnOnce() -> R) -> R {
        let previous = READING.with(|cell| cell.replace(Some(blocks.clone())));
        let result = read();
        READING.with(|cell| *cell.borrow_mut() = previous);
        result
    }

    /// `write` run with every array it serializes set aside into `blocks`, a marker left in its place.
    pub fn writing<R>(blocks: &mut Vec<Block>, write: impl FnOnce() -> R) -> R {
        let previous = WRITING.with(|cell| cell.replace(Some(std::mem::take(blocks))));
        let result = write();
        *blocks = WRITING.with(|cell| std::mem::replace(&mut *cell.borrow_mut(), previous)).unwrap_or_default();
        result
    }
}

impl<T: Element> Serialize for Array<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let at = WRITING.with(|cell| {
            cell.borrow_mut().as_mut().map(|blocks| {
                blocks.push(T::block(self.0.clone()));
                blocks.len() - 1
            })
        });
        match at {
            Some(at) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry(MARKER, &at)?;
                map.end()
            }
            None => self.0.serialize(serializer),
        }
    }
}

impl<'de, T: Element> Deserialize<'de> for Array<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ArrayVisitor(PhantomData))
    }
}

struct ArrayVisitor<T>(PhantomData<T>);

impl<'de, T: Element> Visitor<'de> for ArrayVisitor<T> {
    type Value = Array<T>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "a block of {}, or a list of them", T::KIND)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(value) = seq.next_element()? {
            values.push(value);
        }
        Ok(Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let key: String = map.next_key()?.ok_or_else(|| de::Error::custom("an empty object where a block was expected"))?;
        if key != MARKER {
            return Err(de::Error::custom(format!("an object with \"{key}\" where a block was expected")));
        }
        let at: usize = map.next_value()?;
        READING.with(|cell| {
            let blocks = cell.borrow();
            let blocks = blocks.as_ref().ok_or_else(|| de::Error::custom("a block's marker read outside a run — there are no blocks to resolve it"))?;
            let block = blocks.get(at).ok_or_else(|| de::Error::custom(format!("block {at} of {}", blocks.len())))?;
            let values = T::of(block).ok_or_else(|| de::Error::custom(format!("a block of {} where {} was declared", block.kind(), T::KIND)))?;
            Ok(Array(values.to_vec()))
        })
    }
}

// schema — native component sources and older schemas compiled through protobuf for every language.
export { Schema, type SchemaOpts, type SchemaT, type Described } from "./schema"
// The name a path segment has as a Rust module — what the crate mounts a cognet's own .rs files by, as the schemas' are.
export { rust } from "./rust"
export { contractOf } from "./interfaces"

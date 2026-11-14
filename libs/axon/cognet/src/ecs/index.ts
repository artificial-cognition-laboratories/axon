// ecs — the cognet's world. Opt-in: a cognet that never touches an entity
// doesn't need this module. The world clock lives in ../clock.ts and is
// always present.
export { Ecs, type EcsT, type EcsOpts, type EcsEmit } from "./ecs"
export type { StateOpts, StateT } from "./state"
export { Schema, type SchemaT, type SchemaOpts, type Archetype, type ComponentDescriptor, type FrameDescriptor, type DeclaredComponent, type DeclaredFrame } from "./schema"
export {
    component,
    query,
    frame,
    definitions,
    type Component,
    type ComponentOpts,
    type Definition,
    type Frame,
    type Identity,
    type Named,
    type Query,
    type QueryOpts,
    type QueryShape,
} from "./handle"
export type { ComponentWatcher, EntityId, QueryObservation, Read, Stamp, Write, ComponentEntry } from "./types"
export type { Change } from "./isolation"
export type { Match, Row, Select, Short, Where, Writing } from "./named"
export type { Meta } from "./state"
export type { Written } from "./history"

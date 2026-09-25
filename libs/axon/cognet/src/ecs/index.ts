// ecs — the cognet's world. Opt-in: a cognet that never queries an entity
// doesn't need this module. The world clock lives in ../clock.ts and is
// always present.
export { Ecs, type EcsT, type EcsOpts, type EcsEmit } from "./ecs"
export type { StateOpts } from "./state"
export { Schema, type SchemaT, type SchemaOpts, type ComponentDescriptor, type FrameDescriptor } from "./schema"
export type {
    ComponentRegistry,
    ComponentType,
    ComponentWatcher,
    EntityId,
    QueryDescriptor,
    Read,
    Stamp,
    WorldQueryResult,
} from "./types"

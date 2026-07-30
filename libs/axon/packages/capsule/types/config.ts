// Capsule config types are the capsule wire contract — they live in
// @arcforge/types (single source for all types) and are re-exported here so
// capsule internals and existing importers resolve them from the same place.
export type {
    CapsuleHostRequest,
    CapsuleHost,
    CapsuleTool,
    CapsuleBlueprint,
    CapsulePartialConfig,
} from "@arcforge/types"

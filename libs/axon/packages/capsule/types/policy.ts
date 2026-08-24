// Policy types are the capsule wire contract — they live in @arcforge/types
// (single source for all types) and are re-exported here so capsule internals
// (mediator.ts) and existing importers resolve them from the same place.
export type {
    PolicyRule,
    PolicyBucket,
    CapsulePolicy,
    PolicyResponseCommand,
    PolicyCall,
    EscalationCall,
} from "@arcforge/types"

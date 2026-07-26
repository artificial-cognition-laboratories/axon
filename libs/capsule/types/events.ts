/**
 * The capsule event vocabulary lives in @arcforge/types' session event registry
 * (session/events/capsule.ts) — every type that can reach a session log is
 * registered there before use. This module re-exports it under the names
 * the capsule's own internals have always used; `CapsuleEvent` is the
 * historical local alias for `CapsuleEventMap`.
 */
export type { CapsuleEventMap as CapsuleEvent, CapsuleEventName, AnyCapsuleEvent } from "@arcforge/types"

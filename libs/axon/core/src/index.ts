export { Axon } from "./Axon"
// Role resolution, exported for the SUPERVISOR: a confined agent must never
// resolve a role, because resolution means building a driver from a
// credential. The supervisor does it once on its own side and vends tokens.
export { Inference } from "./runtime/inference"
// What can be known of an agent's grants before it runs — checked at prepare.
export { checked as checkGrants } from "./runtime/services"
// Every use held to its interface's conformance cases, filled as a boot fills it — what `axon conform` runs.
export { Conform, type Conformed } from "./runtime/conform"
export { AxonBlueprint } from "./platform"
// The event bus, exported for the SUPERVISOR: a linked agent has no in-heap
// runtime to announce on, so its commits fan out through one of these instead.
export { AxonBus } from "./platform"
export type { AxonT, AxonHost } from "./Axon"
export { toScope, toScopeModule, isLoadable } from "@arcforge/kernel"
export { scopeToDts, scopeMemberCount } from "@arcforge/air"

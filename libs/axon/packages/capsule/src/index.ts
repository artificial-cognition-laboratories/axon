// @arcforge/capsule — the bounded place agent-emitted code runs.
//
// A capsule is where an agent's own code executes under policy, with
// everything it does on the record: model-emitted <typescript>, the tools it
// calls, the processes it spawns. That concept is unchanged.
//
// What changed is the mechanism. A capsule used to BE a subprocess, because
// the boundary sat between the kernel and the code it ran. Once the whole
// agent became a confined process, that inner boundary was redundant — the
// wall is the agent's own bwrap box, and the capsule is the mediated scope
// inside it. Same guarantees, one process instead of two, no wire.
//
// What was genuinely lost is hard cancellation: killing a process could stop
// a tight synchronous loop, and nothing in one heap can. `interrupt` is
// cooperative, and a run that will not cooperate is ended by the supervisor
// restarting the agent. See inproc/manager.ts.
export { InProcCapsule as Capsule, type InProcCapsuleT as CapsuleT } from "./inproc/manager"
export * from "../types"

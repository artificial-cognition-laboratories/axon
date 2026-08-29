/**
 * procs — the process tree of every agent on this machine.
 *
 * `procTree()` folds a session's event log into the tree any surface renders.
 * It is pure and source-agnostic by construction, which is the whole reason it
 * lives here rather than inside the capsule: the TUI used to build this by
 * reaching through `runtime.kernel.userland` into a live capsule handle, so an
 * attached deployment's process list was structurally always empty.
 *
 * The supervisor half — spawning and confining the agent processes themselves —
 * is `build/runtime/instances.ts`. These two are one tree conceptually (an
 * agent process, and the children it spawned) and become one manager when the
 * agent boundary moves out to the whole process.
 */
export { procTree, appendOutput, type ProcNode, type ProcLogEvent } from "./tree"

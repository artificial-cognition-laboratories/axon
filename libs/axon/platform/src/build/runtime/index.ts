// runtime — every agent running on this machine.
// Runtime() is the module's single entry point.

export { Runtime, type RuntimeT } from "./runtime"
export { Escalations, type EscalationsT, type EscalationHandler } from "./escalations"
export { Resolve, type ResolveT, type ResolvedAgent, type RefKind } from "./resolve"
export { isRemote, type InstanceT, type InstanceSource, type RemoteTarget, type SpawnOpts } from "./instances"
export type { AgentT } from "./agent"
export { stageFor, unitFor, type BootStage, type BootProgress, type BuildUnit, type UnitTiming } from "./progress"
export { sessionHasEntries, sessionHead, isListableSession, type SessionRecord, type SessionHead } from "./sessions"
export { ZENO, type ZenoT } from "./zeno"
export { Profile, type ProfileT } from "./profile"
// Sessions() acts on ONE log by path (fork, rename) as well as listing them,
// so it is reachable on its own rather than only through Runtime().
export { Sessions, type SessionsT } from "./sessions"

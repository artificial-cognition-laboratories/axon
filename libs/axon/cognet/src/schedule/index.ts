// schedule — systems, their rates, and the data lineage between them. Opt-in
// alongside ./ecs: a control loop with no world has nothing to schedule.
export { Schedule, type ScheduleT, type ScheduleOpts } from "./schedule"
export type { LineageT } from "./lineage"
export type { LineageEntry, ScheduleTrace, SystemContext, SystemSpec } from "./types"

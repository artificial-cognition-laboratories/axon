// test — native Bun test execution, projected into a structured event stream.
// TestRunner() is the module's single entry point.

export { TestRunner, type TestRunnerT } from "./runner"
export { Events, type EventsT } from "./events"
export { resolveTestFiles } from "./files"
export type { TestRunOptions, TestRunResult } from "./types"

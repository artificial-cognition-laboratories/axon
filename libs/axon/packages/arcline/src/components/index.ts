/**
 * components — the composable vocabulary every view is built from.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 *
 * A component is a pure function `(renderer, opts) => string | string[]`. It
 * prints nothing, holds no state, and moves no cursor. It returns LINES rather
 * than a joined block so a view can interleave blank lines and sub-groups
 * without re-splitting a string it was just handed.
 *
 * The set is closed on purpose, the same way the colour and icon sets are. A
 * general-purpose widget library would let every surface look slightly
 * different; these are the eight shapes Axon surfaces are actually made of.
 */

export { header, type HeaderOpts } from "./header.ts"
export { row, rows, type Row, type RowsOpts } from "./row.ts"
export { tree, type TreeNode, type TreeOpts } from "./tree.ts"
export { status, next, rule, list, table, type Status } from "./text.ts"
export { steps, duration, SPINNER_FRAMES, type Step, type StepState, type StepsOpts } from "./steps.ts"
export { results, summarize, type Result, type ResultOutcome, type ResultsOpts } from "./results.ts"
export { entries, compact, type Entry, type EntriesOpts } from "./entries.ts"
export { logs, type LogLine, type LogsOpts } from "./logs.ts"
export { errorReport, type ErrorReportOpts } from "./errorReport.ts"

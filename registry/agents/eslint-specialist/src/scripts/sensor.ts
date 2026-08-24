/**
 * sensor — Pure measurement. No LLM. Fast.
 *
 * Runs ESLint, records the audit into state, and outputs the error signal as JSON.
 * Used by pre-commit hooks and CI. Other scripts (report, tighten) consume its output.
 *
 * Usage: axon run sensor [path]
 *   path defaults to "." (whole project)
 *
 * Exit codes:
 *   0 — clean (no regressions or diverging rules)
 *   1 — regressions or divergence detected
 *   2 — state not initialised (setup not run)
 */

import { eslint } from "../tools/eslint"
import { state } from "../tools/state"

const targetPath = process.argv[2] ?? "."

const current = await state.read()
if (!current) {
    console.error("No state found. Run: axon run setup")
    process.exit(2)
}

const counts = await eslint.counts(targetPath)

// Use state as the source of truth for configured rule levels
const configuredRules = Object.fromEntries(
    Object.entries(current.rules).map(([rule, r]) => [rule, r.current])
)

const updated = await state.record(counts, configuredRules)
const signal = await state.signal()
const totalViolations = Object.values(counts).reduce((n, c) => n + c, 0)

process.stdout.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    path: targetPath,
    totalViolations,
    signal,
    counts,
}, null, 2) + "\n")

if (signal.regressing.length > 0 || signal.diverging.length > 0) {
    process.exit(1)
}

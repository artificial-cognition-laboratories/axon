/**
 * fix — Actuator: reduce violations in code.
 *
 * Two phases:
 *   1. Auto-fix: run eslint --fix on the target path (handles ~60% of violations)
 *   2. Manual fix: pass remaining violations to the agent for context-aware rewriting
 *
 * The agent will not fix violations that would require changing logic.
 * Those are reported as findings at the end of the run.
 *
 * Usage:
 *   axon run fix .              — fix everything
 *   axon run fix src/           — fix a directory
 *   axon run fix src/foo.ts     — fix a single file
 *   axon run fix . --rule @typescript-eslint/no-explicit-any  — fix one rule only
 */

import { eslint } from "../tools/eslint"
import { state } from "../tools/state"

const args = process.argv.slice(2)
const targetPath = args.find(a => !a.startsWith("--")) ?? "."
const ruleFilter = args.find((a, i) => args[i - 1] === "--rule") ?? null

const current = await state.read()
if (!current) {
    console.error("No state found. Run: axon run setup")
    process.exit(1)
}

// Phase 1: Auto-fix
console.log(`Running auto-fix on ${targetPath}...`)
const before = await eslint.run(targetPath)
await eslint.run(targetPath, { fix: true })
const afterAutoFix = await eslint.run(targetPath)

const autoFixed = (before.totalErrors + before.totalWarnings)
    - (afterAutoFix.totalErrors + afterAutoFix.totalWarnings)

console.log(`Auto-fixed ${autoFixed} violations.`)

// Phase 2: Collect remaining violations for agent
const remaining = afterAutoFix.files
    .filter(f => f.violations.length > 0)
    .filter(f => ruleFilter ? f.violations.some(v => v.ruleId === ruleFilter) : true)

if (remaining.length === 0) {
    console.log("No remaining violations. All done.")
    process.exit(0)
}

console.log(`${remaining.length} files still have violations. Passing to agent for manual fix...`)

// Cap at 20 files per run to keep the agent focused
const batch = remaining.slice(0, 20)
const skipped = remaining.length - batch.length

const fileContexts = batch.map(f => {
    const relevantViolations = ruleFilter
        ? f.violations.filter(v => v.ruleId === ruleFilter)
        : f.violations

    return `### ${f.filePath}
Violations:
${relevantViolations.map(v => `  Line ${v.line}: [${v.ruleId}] ${v.message}`).join("\n")}`
}).join("\n\n---\n\n")

await axon.request({
    prompt: `
You are fixing ESLint violations in this project.

Auto-fix already ran and handled ${autoFixed} violations automatically.
The remaining violations require reading the file and making targeted edits.
${ruleFilter ? `You are focused on rule: ${ruleFilter}` : "Fix all remaining violations."}
${skipped > 0 ? `Note: ${skipped} additional files were skipped this run. Fix this batch first, then re-run.` : ""}

For each file below:
1. Read the file using the read tool.
2. Understand each violation in context — do not guess.
3. Apply the minimum change that fixes the violation without changing logic.
4. Write the fixed file.
5. For any violation that would require a logic change to fix, report it as a finding instead.

Do not narrate each fix — just fix and report findings at the end.

${fileContexts}
    `.trim(),
    thread: "fix",
})

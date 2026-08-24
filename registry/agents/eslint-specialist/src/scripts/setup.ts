/**
 * setup — First-run onboarding script.
 *
 * Detects project shape, runs the initial full audit, derives the setpoint,
 * and writes data/eslint-state.json. Run once before any other script.
 *
 * Usage: axon run setup
 */

import { eslint } from "../tools/eslint"
import { state, type EslintState } from "../tools/state"

const shape = eslint.detectShape()

if (!shape.eslintConfigPath) {
    console.error("No ESLint config found in this project. Create one first.")
    process.exit(1)
}

console.log("Detected project shape:", JSON.stringify(shape, null, 2))
console.log("Running initial audit — this may take a moment...")

const counts = await eslint.counts(".")
const totalViolations = Object.values(counts).reduce((n, c) => n + c, 0)

console.log(`Found ${totalViolations} violations across ${Object.keys(counts).length} rules.`)

const configSource = eslint.config.read(shape.eslintConfigPath)

const now = new Date().toISOString()

const rules: EslintState["rules"] = {}
for (const [rule, count] of Object.entries(counts)) {
    rules[rule] = {
        current: "warn", // conservative — will be updated from config parse by agent
        setpoint: "error",
        violations: count,
        previousViolations: null,
        phase: count === 0 ? 3 : 2,
        trend: "unknown",
        lastAudit: now,
    }
}

await state.write({
    createdAt: now,
    lastAudit: now,
    projectShape: shape,
    rules,
    auditHistory: [{ date: now, totalViolations, ruleSnapshot: { ...counts } }],
})

console.log("\nSetup complete. State written to data/eslint-state.json.")
console.log("\nViolations by rule:")
const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a)
for (const [rule, count] of sorted) {
    console.log(`  ${rule}: ${count}`)
}
console.log(`\nNext steps:
  axon run report    — see the convergence report
  axon run fix .     — fix auto-fixable violations
  axon run tighten   — promote rules that are ready
`)

await axon.request({
    prompt: `
You have just run the initial audit for a new project.

Project shape:
${JSON.stringify(shape, null, 2)}

Current ESLint config:
\`\`\`
${configSource}
\`\`\`

Violation counts by rule:
${sorted.map(([r, c]) => `  ${r}: ${c}`).join("\n")}

Review the config and violation counts. Using your rule taxonomy knowledge:
1. For each rule currently configured, assess whether the current level (warn/error/off) is appropriate.
2. Identify any rules that are absent from the config but should be added to the setpoint.
3. Identify any rules with zero violations that are ready to promote immediately.
4. Identify the two or three rules with the most violations that should be the first fix campaign.

Produce a concise onboarding summary for the engineer. Be specific about what you recommend tackling first and why.
    `.trim(),
    thread: "setup",
})

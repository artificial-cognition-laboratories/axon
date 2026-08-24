/**
 * tighten — Actuator: promote rules toward setpoint in the ESLint config.
 *
 * Finds rules with zero violations that are below their setpoint and proposes
 * promoting them. By default shows the proposal only — pass --apply to write.
 *
 * Never promotes a rule that still has violations.
 * Never adds a rule directly at "error" — always introduces at "warn" first.
 * Caps at 5 promotions per run to keep changes reviewable.
 *
 * Usage:
 *   axon run tighten           — show proposed changes
 *   axon run tighten --apply   — write config changes after review
 */

import { eslint } from "../tools/eslint"
import { state } from "../tools/state"

const apply = process.argv.includes("--apply")

const current = await state.read()
if (!current) {
    console.error("No state found. Run: axon run setup")
    process.exit(1)
}

if (!current.projectShape.eslintConfigPath) {
    console.error("No ESLint config path in state. Re-run setup.")
    process.exit(1)
}

const signal = await state.signal()

if (signal.ready.length === 0 && signal.absent.length === 0) {
    console.log("Nothing ready to tighten.")
    if (signal.diverging.length > 0) {
        console.log(`Fix diverging rules first: ${signal.diverging.join(", ")}`)
    }
    process.exit(0)
}

const configSource = eslint.config.read(current.projectShape.eslintConfigPath)

const readyDetails = signal.ready.map(rule => {
    const r = current.rules[rule]
    return `  ${rule}: ${r.current} → ${r.setpoint} (${r.violations} violations, trend: ${r.trend})`
}).join("\n")

const absentDetails = signal.absent.map(rule => {
    const r = current.rules[rule]
    return `  ${rule}: not in config, setpoint is ${r.setpoint}`
}).join("\n")

console.log(`Rules ready to promote:\n${readyDetails || "  none"}`)
console.log(`Rules absent from config:\n${absentDetails || "  none"}`)
if (!apply) console.log("\nRun with --apply to write these changes.")

await axon.request({
    prompt: `
You are tightening the ESLint config for this project.

${apply
    ? "The engineer has approved. Write the updated config using the write tool."
    : "Propose the changes only. Do NOT write the config — show a diff and explanation."}

Current ESLint config:
\`\`\`
${configSource}
\`\`\`

Config path: ${current.projectShape.eslintConfigPath}

Rules ready to promote (violations = 0, current level is below setpoint):
${readyDetails || "  none"}

Rules absent from config that should be introduced at warn level:
${absentDetails || "  none"}

For each change:
1. One sentence on why it is safe to make now.
2. The exact diff — what line changes and how.
3. Any caveats (options required, framework-specific behaviour, etc.)

Constraints:
- Rules being introduced must start at "warn", never "error".
- Rules being promoted to "error" must have zero violations confirmed above.
- Promote at most 5 rules per run. Prioritise: correctness → safety → style.

${apply ? "After explaining each change, write the complete updated config file." : "Show the proposal only. The engineer will run --apply to commit it."}
    `.trim(),
    thread: "tighten",
})

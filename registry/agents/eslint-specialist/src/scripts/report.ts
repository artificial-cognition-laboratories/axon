/**
 * report — Human-readable convergence report.
 *
 * Reads current state, builds the convergence table, and asks the agent to
 * produce a structured assessment: health, immediate actions, next campaign,
 * rules ready to promote, and overall trend direction.
 *
 * Usage: axon run report
 */

import { state } from "../tools/state"

const current = await state.read()
if (!current) {
    console.error("No state found. Run: axon run setup")
    process.exit(1)
}

const signal = await state.signal()
const totalViolations = Object.values(current.rules).reduce((n, r) => n + r.violations, 0)

const table = Object.entries(current.rules)
    .filter(([, r]) => r.setpoint !== "off")
    .sort(([, a], [, b]) => b.violations - a.violations)
    .map(([rule, r]) => {
        const trend = { increasing: "↑", decreasing: "↓", stable: "→", zero: "✓", unknown: "?" }[r.trend]
        return `${rule.padEnd(55)} ${r.setpoint.padEnd(6)} ${r.current.padEnd(6)} ${String(r.violations).padEnd(12)} ${trend}`
    }).join("\n")

await axon.request({
    prompt: `
You are producing a convergence report for this project's ESLint state.

Current state summary:
- Last audit: ${current.lastAudit ?? "never"}
- Total violations: ${totalViolations}
- Project: ${current.projectShape.hasTypeScript ? "TypeScript" : "JavaScript"}${current.projectShape.hasVue ? " + Vue" : ""}${current.projectShape.isMonorepo ? " monorepo" : ""}

Error signal:
- Diverging (violations increasing): ${signal.diverging.join(", ") || "none"}
- Regressing (errors with violations): ${signal.regressing.join(", ") || "none"}
- Actively fixing (violations > 0): ${signal.fixing.join(", ") || "none"}
- Ready to promote (violations = 0): ${signal.ready.join(", ") || "none"}
- Converged: ${signal.converged.join(", ") || "none"}
- Absent from config: ${signal.absent.join(", ") || "none"}

Convergence table (rule | setpoint | current | violations | trend):
${table}

Audit history (last 5):
${current.auditHistory.slice(-5).map(h => `  ${h.date}: ${h.totalViolations} total violations`).join("\n")}

Produce a convergence report for the engineer. Structure it as:
1. Overall health — one sentence on where the project stands.
2. Immediate action — what to do right now (diverging or regressing rules must be addressed first).
3. Next fix campaign — which rule to focus on next and why (highest impact per effort).
4. Ready to promote — list rules with zero violations that can be tightened now.
5. Trend — is the project converging or drifting? Is the rate improving?

Be direct. Numbers matter. Don't pad.
    `.trim(),
    thread: "report",
})

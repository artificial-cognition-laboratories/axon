import * as fs from "fs"
import * as path from "path"

export type RuleLevel = "off" | "warn" | "error"
export type RulePhase = 0 | 1 | 2 | 3 | 4
export type Trend = "increasing" | "stable" | "decreasing" | "zero" | "unknown"

export interface RuleState {
    /** Current level in the ESLint config */
    current: RuleLevel
    /** Target level from the setpoint */
    setpoint: RuleLevel
    /** Current violation count */
    violations: number
    /** Violation count at previous audit */
    previousViolations: number | null
    /** Convergence phase (0=absent, 1=measuring, 2=fixing, 3=ready, 4=converged) */
    phase: RulePhase
    /** Direction of change since last audit */
    trend: Trend
    /** ISO date of last audit */
    lastAudit: string | null
}

export interface EslintState {
    /** ISO date this state was initialised */
    createdAt: string
    /** ISO date of last audit */
    lastAudit: string | null
    /** Project shape detected at setup */
    projectShape: {
        hasTypeScript: boolean
        hasVue: boolean
        hasReact: boolean
        isMonorepo: boolean
        isLibrary: boolean
        eslintConfigPath: string | null
    }
    /** Per-rule state */
    rules: Record<string, RuleState>
    /** Audit history (last 10) */
    auditHistory: Array<{
        date: string
        totalViolations: number
        ruleSnapshot: Record<string, number>
    }>
}

export interface ErrorSignal {
    /** Rules diverging (violations increasing) — highest priority */
    diverging: string[]
    /** Rules with violations at error level — regressions */
    regressing: string[]
    /** Rules at warn with violations, actively being fixed */
    fixing: string[]
    /** Rules at zero violations, ready to promote toward setpoint */
    ready: string[]
    /** Rules fully converged at setpoint with zero violations */
    converged: string[]
    /** Rules in setpoint but absent from config */
    absent: string[]
}

const STATE_PATH = path.join(process.cwd(), "data", "eslint-state.json")

export const state = {
    /**
     * Read the current ESLint state from disk.
     * Returns null if setup has not been run yet — always check before using.
     */
    async read(): Promise<EslintState | null> {
        try {
            return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"))
        } catch {
            return null
        }
    },

    /**
     * Write ESLint state to disk, replacing the existing state entirely.
     * Prefer update() for partial mutations to avoid read-modify-write boilerplate.
     */
    async write(s: EslintState): Promise<void> {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
        fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), "utf-8")
    },

    /**
     * Read the current state, apply a transformation, and write the result.
     * Use this for any mutation that doesn't require a full audit — e.g. adjusting
     * a rule's setpoint or marking a rule as out of scope.
     * Throws if state has not been initialised.
     */
    async update(fn: (s: EslintState) => EslintState): Promise<void> {
        const current = await state.read()
        if (!current) throw new Error("No state found. Run: axon run setup")
        await state.write(fn(current))
    },

    /**
     * Compute and return the error signal from current state.
     * The error signal is the gap between setpoint and current state, grouped by urgency:
     * diverging → regressing → fixing → ready → converged → absent.
     * Use this in report and tighten scripts to understand what to act on next.
     * Throws if state has not been initialised.
     */
    async signal(): Promise<ErrorSignal> {
        const s = await state.read()
        if (!s) throw new Error("No state found. Run: axon run setup")
        return computeErrorSignal(s)
    },

    /**
     * Record a fresh audit result into state.
     * Takes the raw violation counts from eslint.counts() and the current configured
     * rule levels, computes trends and phases for every rule, appends to audit history,
     * and persists. Returns the updated state.
     * Call this at the end of every sensor run.
     * Throws if state has not been initialised.
     */
    async record(
        counts: Record<string, number>,
        configuredRules: Record<string, RuleLevel>,
    ): Promise<EslintState> {
        const current = await state.read()
        if (!current) throw new Error("No state found. Run: axon run setup")
        const updated = applyAudit(current, counts, configuredRules)
        await state.write(updated)
        return updated
    },
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function computeErrorSignal(s: EslintState): ErrorSignal {
    const diverging: string[] = []
    const regressing: string[] = []
    const fixing: string[] = []
    const ready: string[] = []
    const converged: string[] = []
    const absent: string[] = []

    for (const [rule, r] of Object.entries(s.rules)) {
        if (r.setpoint === "off") continue

        if (r.current === "off") { absent.push(rule); continue }
        if (r.trend === "increasing" && r.violations > 0) { diverging.push(rule); continue }
        if (r.current === "error" && r.violations > 0) { regressing.push(rule); continue }
        if (r.violations === 0 && r.current !== r.setpoint) { ready.push(rule); continue }
        if (r.violations === 0 && r.current === r.setpoint) { converged.push(rule); continue }
        if (r.violations > 0) { fixing.push(rule) }
    }

    return { diverging, regressing, fixing, ready, converged, absent }
}

function applyAudit(
    s: EslintState,
    counts: Record<string, number>,
    configuredRules: Record<string, RuleLevel>,
): EslintState {
    const now = new Date().toISOString()
    const totalViolations = Object.values(counts).reduce((n, c) => n + c, 0)

    const allRules = new Set([
        ...Object.keys(s.rules),
        ...Object.keys(counts),
        ...Object.keys(configuredRules),
    ])

    const rules: Record<string, RuleState> = {}

    for (const rule of allRules) {
        const existing = s.rules[rule]
        const violations = counts[rule] ?? 0
        const current = configuredRules[rule] ?? existing?.current ?? "off"
        const setpoint = existing?.setpoint ?? deriveSetpoint(rule, current)
        const prev = existing?.violations ?? null

        rules[rule] = {
            current,
            setpoint,
            violations,
            previousViolations: prev,
            phase: computePhase(current, setpoint, violations),
            trend: computeTrend(prev, violations),
            lastAudit: now,
        }
    }

    const auditHistory = [
        ...s.auditHistory,
        { date: now, totalViolations, ruleSnapshot: { ...counts } },
    ].slice(-10)

    return { ...s, rules, lastAudit: now, auditHistory }
}

function computeTrend(prev: number | null, current: number): Trend {
    if (current === 0) return "zero"
    if (prev === null) return "unknown"
    if (current > prev) return "increasing"
    if (current < prev) return "decreasing"
    return "stable"
}

function computePhase(current: RuleLevel, setpoint: RuleLevel, violations: number): RulePhase {
    if (current === "off") return 0
    if (current === "warn" && violations > 0) return 2
    if (current === "warn" && violations === 0 && setpoint === "error") return 3
    if (current === "error" && violations === 0) return 4
    return 1
}

function deriveSetpoint(rule: string, current: RuleLevel): RuleLevel {
    const correctness = ["no-undef", "no-unreachable", "no-duplicate-case", "use-isnan",
        "@typescript-eslint/no-floating-promises", "@typescript-eslint/no-unsafe-assignment"]
    if (correctness.includes(rule)) return "error"

    const safety = ["no-var", "no-empty", "eqeqeq", "@typescript-eslint/no-explicit-any",
        "@typescript-eslint/no-non-null-assertion", "@typescript-eslint/ban-ts-comment"]
    if (safety.includes(rule)) return "error"

    const style = ["prefer-const", "no-duplicate-imports", "@typescript-eslint/no-unused-vars"]
    if (style.includes(rule)) return "error"

    return current
}

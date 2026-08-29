/**
 * prepare — get a project ready to run.
 *
 *     ✓ zeno ready  1.2s
 *
 * ── The quiet command ──────────────────────────────────────────────────────
 *
 * Prepare is not like the other views here. It runs on every `axon dev`,
 * `axon install` and `axon deploy`, and the overwhelmingly common outcome is
 * that nothing changed — the modules are installed, the types are current, the
 * tree is coherent. So the default rendering is ONE LINE.
 *
 * That is a deliberate inversion of everything else in this package. A
 * five-row step list reporting that five things did not need doing is noise,
 * and noise on a command that runs ten times an hour is worse than useless: it
 * trains the reader to skip the output, and then they skip the run where
 * something did change. The steps appear when there is something to say.
 *
 * ── Warnings are the payload ───────────────────────────────────────────────
 *
 * A ScanWarning — a shadowed tool name, an unparseable model spec — is the
 * thing prepare uniquely produces, and the previous output printed them in a
 * loop between module lines where they read as more progress chatter. On a
 * command that is otherwise silent, a warning should be the loudest thing on
 * screen, so it gets its own block and the summary line reports the count.
 *
 * ── --frozen is a check, not a build ───────────────────────────────────────
 *
 * `--frozen` asserts that the manifest, lockfile and node_modules already
 * agree, and fails on drift instead of reconciling. That is a different verb
 * wearing the same name, so it says so — "verified" rather than "ready", and
 * a failure names the drift rather than the work it declined to do.
 */

import {
    header,
    errorReport,
    results,
    status,
    steps,
    type Result,
    type Step,
} from "../components/index.ts"
import { icons, padEnd } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"

/** The phases prepare reports, in order. Mirrors platform's BuildReporter spans. */
export const PREPARE_STEPS = ["Framework", "Modules", "Cognet", "Tree", "Types"] as const

export type PrepareWarning = {
    /** Which scanner raised it — "tools", "models", "prompts". */
    domain: string
    message: string
}

export type PrepareOpts = {
    /** The project being prepared. */
    project: string
    /** Asserting rather than reconciling. */
    frozen?: boolean
    /**
     * The phases, while running.
     *
     * Dropped from the finished render when nothing changed — see the module
     * comment. Kept when there is work to show, so a slow prepare is legible
     * while it happens.
     */
    steps?: Step[]
    /** Modules touched this run. Only the ones that CHANGED are worth listing. */
    modules?: Result[]
    frame?: string
    result?: {
        /** True when the run made no changes — the silent case. */
        unchanged?: boolean
        warnings?: PrepareWarning[]
        ms?: number
    }
    failure?: {
        error: AxonErrorLike
        hint?: string
    }
}

export function prepare(r: RendererHandle, opts: PrepareOpts): string {
    const lines: string[] = []
    const settled = Boolean(opts.result || opts.failure)

    // While running, the view is a normal step list — a prepare that takes ten
    // seconds must say what it is doing. It collapses only once finished.
    if (!settled) {
        lines.push("")
        lines.push(header(r, {
            title: opts.frozen ? "Verifying" : "Preparing",
            subtitle: opts.project,
        }))
        lines.push("")
        if (opts.steps?.length) {
            lines.push(...steps(r, opts.steps, opts.frame !== undefined ? { frame: opts.frame } : {}))
        }
        lines.push("")
        return lines.join("\n")
    }

    if (opts.result) {
        const warnings = opts.result.warnings ?? []
        const changed = (opts.modules ?? []).filter(m => m.outcome !== "noop")

        const summary = status(
            r,
            warnings.length > 0 ? "warn" : "ok",
            summaryText(opts, warnings.length),
            opts.result.ms !== undefined && !opts.result.unchanged
                ? `${(opts.result.ms / 1000).toFixed(1)}s`
                : undefined,
        )

        // Nothing to report above it, so the whole answer is one line — and a
        // one-line answer gets no padding. The blanks exist to separate blocks
        // from each other; with no blocks they only push a quiet command's
        // output around, which is exactly what makes `prepare` feel heavier
        // than the work it did.
        if (changed.length === 0 && warnings.length === 0) return summary

        // What changed, if anything did. A module that was already installed is
        // not mentioned at all here — prepare's job is to reach a state, and
        // the parts already in that state are not news.
        if (changed.length > 0) {
            lines.push("")
            lines.push(...results(r, changed))
        }

        if (warnings.length > 0) {
            lines.push("")
            lines.push(...warningLines(r, warnings))
        }

        lines.push("")
        lines.push(summary)
        lines.push("")
        return lines.join("\n")
    }

    if (opts.failure) {
        lines.push("")
        lines.push(...errorReport(r, opts.failure.error, {
            ...(opts.failure.hint ? { hint: opts.failure.hint } : {}),
        }))
        lines.push("")
    }

    return lines.join("\n")
}

/**
 * One line that says what state the project is now in.
 *
 * Phrased as a STATE ("ready", "verified") rather than an action ("prepared"),
 * because that is the question being asked. Nobody runs prepare to have
 * prepared; they run it to be able to run something else.
 */
function summaryText(opts: PrepareOpts, warnings: number): string {
    const verb = opts.frozen ? "verified" : "ready"
    const tail = warnings > 0
        ? ` — ${warnings} ${warnings === 1 ? "warning" : "warnings"}`
        : ""
    return `${opts.project} ${verb}${tail}`
}

function warningLines(r: RendererHandle, warnings: PrepareWarning[]): string[] {
    // The domain is a column, not a prefix — several warnings from one scanner
    // is the normal case, and an unaligned label makes them read as unrelated.
    const domainWidth = Math.max(...warnings.map(w => w.domain.length))

    return warnings.map(warning =>
        `${r.c.warn(icons.warn)} ${r.c.dim(padEnd(warning.domain, domainWidth))}  ${r.c.text(warning.message)}`,
    )
}

/**
 * update — installing a new Axon over the running one.
 *
 *     Updating Axon
 *
 *     ✓ Installing   2.1s   2.0.158 → 2.0.159
 *     ✓ Verifying    340ms
 *
 *     ✓ updated to 2.0.159
 *
 *     ➜  axon
 *
 * ── Why this one is different ──────────────────────────────────────────────
 *
 * Every other view narrates work the CLI is doing. This narrates work done to
 * the CLI, by a separate helper process that runs AFTER the app has exited —
 * so there is no session to return to and nothing to attach. What the user
 * needs is the shortest possible answer to "am I on the new one, and if not,
 * what am I on?"
 *
 * ── Rollback is a state, not a failure ────────────────────────────────────
 *
 * A failed install that restored the previous version left the machine
 * WORKING. Rendering that as a plain error tells the user something is broken
 * when the honest answer is "nothing changed" — so it is a distinct outcome
 * with its own line, and only a failed ROLLBACK is a real emergency.
 *
 * ── The retry is worth showing ────────────────────────────────────────────
 *
 * A just-published version takes time to propagate across npm edges, so the
 * installer retries with backoff. Without that on screen, a legitimate
 * multi-second wait looks like a hang against a registry that is working
 * exactly as expected.
 */

import { header, next, status, steps, type Step } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"

/** The steps an update moves through, in order. */
export const UPDATE_STEPS = ["Installing", "Verifying"] as const

export type UpdateOpts = {
    /** The version being left behind. */
    from: string
    /** The version being installed. */
    to: string
    steps: Step[]
    frame?: string
    result?: {
        /**
         * How it ended.
         *
         * `current` short-circuits everything: there was nothing to do, and a
         * step list for work that never happened is noise.
         */
        outcome: "installed" | "current" | "rolled-back" | "failed"
        ms?: number
        /**
         * What to run to recover, for the one outcome where the machine is
         * genuinely broken.
         */
        recovery?: string
    }
}

export function update(r: RendererHandle, opts: UpdateOpts): string {
    const lines: string[] = []

    // Nothing to do, so nothing to narrate. One line, like `prepare` when a
    // project is already current.
    if (opts.result?.outcome === "current") {
        return ["", status(r, "ok", `Axon ${opts.to} is current`), ""].join("\n")
    }

    lines.push("")
    lines.push(header(r, { title: "Updating Axon", subtitle: `${opts.from} → ${opts.to}` }))
    lines.push("")
    lines.push(...steps(r, opts.steps, opts.frame !== undefined ? { frame: opts.frame } : {}))

    if (opts.result) {
        lines.push("")
        lines.push(...outcomeLines(r, opts))
    }

    lines.push("")
    return lines.join("\n")
}

function outcomeLines(r: RendererHandle, opts: UpdateOpts): string[] {
    const result = opts.result!
    const elapsed = result.ms !== undefined ? `${(result.ms / 1000).toFixed(1)}s` : undefined

    switch (result.outcome) {
        case "installed":
            return [
                status(r, "ok", `updated to ${opts.to}`, elapsed),
                "",
                // The whole point of updating is to go on using it, and the
                // helper has already replaced the binary the user invoked.
                next(r, "axon"),
            ]

        case "rolled-back":
            // WARN, not error: the install failed and the previous version was
            // restored, so the machine works. Reporting it in red would say
            // "something is broken" about a state where nothing is.
            return [
                status(r, "warn", `${opts.to} failed to verify — still on ${opts.from}`),
                "",
                r.c.dim("nothing changed; the previous version was restored"),
            ]

        case "failed":
            // The genuine emergency: neither version is known good, so this is
            // the one outcome that hands over a command to run.
            return [
                status(r, "fail", `${opts.to} failed and ${opts.from} could not be restored`),
                ...(result.recovery ? ["", next(r, result.recovery)] : []),
            ]

        case "current":
            return [status(r, "ok", `Axon ${opts.to} is current`)]
    }
}

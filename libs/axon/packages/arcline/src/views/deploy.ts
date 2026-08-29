/**
 * deploy — what `axon deploy` shows while it ships an agent to the cloud.
 *
 *     Deploying @cody/zeno
 *
 *     Tier:    small
 *     Warmth:  on-demand
 *     Cost:    ~$10/mo
 *
 *     ✓ Bundling      620ms
 *     ✓ Publishing    2.1s
 *     ✓ Provisioning  4.2s
 *     ⠹ Starting      38.4s   waiting for health check
 *
 *     ✓ deployed in 46.7s
 *
 *     https://zeno-cody.axon.run
 *
 *     Deployment:  dep_8f2a41c9
 *     Tier:        small
 *
 * ── Why this is not just publish with more rows ────────────────────────────
 *
 * Publish is four steps of a second or two. Deploy is those steps plus a wait
 * of genuinely unbounded length: `waitUntilReady` polls every 2s for up to
 * five minutes. Everything below follows from that one fact.
 *
 *   The `Starting` row reports the deployment's OWN phase, not just a spinner.
 *   A spinner sitting for ninety seconds tells a user nothing about whether
 *   the thing is healthy or wedged; the control plane hands us a status on
 *   every poll, so the row says what it actually is. The elapsed clock beside
 *   it stops being decoration and becomes the signal.
 *
 *   The cost block is up top, before any step runs. Deploying provisions real
 *   infrastructure that bills monthly, and the tier is chosen by a flag most
 *   people set once and forget. Showing it is not a confirmation prompt — the
 *   command was explicit — but it must never be a surprise on the invoice.
 *
 *   The ending is a place, not a receipt. A publish ends with a version
 *   number; a deploy ends with a URL you can hit. So the URL is the headline —
 *   its own line under the ✓, not a labelled row among others — and the ✓ line
 *   reports only that it finished and how long it took, because naming the
 *   agent there as well as showing its URL beneath says one thing twice.
 */

import { header, rows, status, steps, errorReport, type Step, type Row, type LogLine } from "../components/index.ts"
import { hyperlink } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"
import { registryUrl } from "./publish.ts"

/** The steps a deploy moves through, in order. Mirrors cloud's DeployStep. */
export const DEPLOY_STEPS = ["Bundling", "Registering", "Publishing", "Provisioning", "Starting"] as const

export type DeployOpts = {
    /** The agent being deployed, e.g. "@cody/zeno". */
    name: string
    /** What it will cost to run. Shown before anything is provisioned. */
    plan?: {
        tier: string
        warmth: string
        /** Human-readable monthly estimate, e.g. "~$10/mo". */
        cost?: string
    }
    steps: Step[]
    /** Spinner glyph for the active step — supplied by the live surface. */
    frame?: string
    result?: {
        /** Where the agent now answers. The headline of the whole view. */
        url: string
        /** Identifiers a follow-up command needs — deployment id, tier. */
        facts?: Array<[label: string, value: string]>
        /** Total elapsed, for the closing line. */
        ms?: number
    }
    failure?: {
        error: AxonErrorLike
        hint?: string
        /** The container's own output — see errorReport's `output`. */
        output?: LogLine[]
    }
}

export function deploy(r: RendererHandle, opts: DeployOpts): string {
    const lines: string[] = []

    lines.push("")
    lines.push(header(r, { title: "Deploying", subtitle: opts.name, href: registryUrl(opts.name) }))
    lines.push("")

    if (opts.plan) {
        lines.push(...rows(r, [
            { label: "Tier", value: opts.plan.tier, arrow: false },
            { label: "Warmth", value: opts.plan.warmth, arrow: false },
            ...(opts.plan.cost ? [{ label: "Cost", value: opts.plan.cost, arrow: false }] : []),
        ]))
        lines.push("")
    }

    lines.push(...steps(r, opts.steps, opts.frame !== undefined ? { frame: opts.frame } : {}))

    if (opts.result) {
        // Outcome, then destination, then identifiers.
        //
        // The URL is not a labelled fact among others — it IS the result, so
        // it gets a line of its own directly under the ✓. Naming the agent in
        // the ✓ line AND showing its URL beneath said one thing twice; the
        // status line now reports only that it finished and how long it took.
        //
        // The identifiers below are a different kind again: not somewhere you
        // go, but strings you paste into the next command. They are arrow-less
        // and quiet, because nobody reads them until they need one.
        lines.push("")
        lines.push(status(
            r,
            "ok",
            opts.result.ms !== undefined
                ? `deployed in ${(opts.result.ms / 1000).toFixed(1)}s`
                : "deployed",
        ))
        lines.push("")
        const url = r.c.primary(opts.result.url)
        lines.push(r.links ? hyperlink(opts.result.url, url) : url)

        if (opts.result.facts?.length) {
            lines.push("")
            lines.push(...rows(r, opts.result.facts.map(([label, value]) => ({ label, value, arrow: false }))))
        }
    }

    if (opts.failure) {
        lines.push("")
        lines.push(...errorReport(r, opts.failure.error, {
            ...(opts.failure.hint ? { hint: opts.failure.hint } : {}),
            ...(opts.failure.output ? { output: opts.failure.output } : {}),
        }))
    }

    lines.push("")
    return lines.join("\n")
}

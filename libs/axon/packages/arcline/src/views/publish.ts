/**
 * publish — what `axon publish` shows while it bundles and uploads.
 *
 *     Publishing @cody/zeno
 *
 *     ✓ Bundling      412ms
 *     ✓ Verifying     1.2s
 *     ✓ Registering   180ms
 *     ⠹ Uploading     2.1s   v0.3.1
 *
 * ── Why a step list and not a single spinner ───────────────────────────────
 *
 * Publish is not one wait, it is five, and they fail for unrelated reasons.
 * A lone spinner cannot distinguish a slow upload from a stuck verification,
 * so the first question on a hung publish ("what is it doing?") has no answer
 * on screen. The list answers it continuously, and the elapsed time on the
 * active row is what separates "slow" from "hung".
 *
 * It is also honest about the retry. A version collision sends the flow back
 * through bump → rebuild → verify; the view re-opens the earlier steps rather
 * than pretending progress is forward-only, and the bump is announced with the
 * version it moved to, because that number is not what the author typed.
 */

import { header, steps, status, rows, results, errorReport, type Step } from "../components/index.ts"
import type { AxonErrorLike } from "@arcforge/err"
import { hyperlink } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

/** The steps a publish moves through, in order. Mirrors platform's PublishStep. */
export const PUBLISH_STEPS = ["Bundling", "Verifying", "Registering", "Uploading"] as const

/** Where a published artifact lives. One format for every kind. */
export function registryUrl(name: string): string {
    return `https://axon.arclabs.it/${name}`
}

export type PublishOpts = {
    /** What is being published, e.g. "@cody/zeno". Linked to its registry page. */
    name: string
    /** The step list, in order. */
    steps: Step[]
    /** Spinner glyph for the active step — supplied by the live surface. */
    frame?: string
    /**
     * The result, once there is one. Its presence is what turns this from a
     * progress display into a report, so a caller never decides which view to
     * render — it renders this one and fills in the outcome when it has it.
     */
    result?: {
        version: string
        visibility: "public" | "private"
        registeredId?: string
        /**
         * README images that shipped, with what compression cost them.
         *
         * Shown because compression is otherwise invisible: an author who
         * wants to know whether their screenshot went out at 2MB or 200KB
         * should not have to go and look.
         */
        assets?: Array<{ path: string; size: string; from?: string }>
        /** Total elapsed, for the closing line. */
        ms?: number
    }
    /**
     * The failure, if it failed.
     *
     * Rendered UNDER the step list rather than replacing it, because the list
     * is the most useful context an error has: which steps passed locates the
     * fault far faster than the message alone. A publish that dies in
     * Verifying is a different problem from one that dies in Uploading, and
     * only the list says which happened.
     */
    failure?: {
        error: AxonErrorLike
        /** The command that resolves this — see errorReport's `hint`. */
        hint?: string
    }
}

export function publish(r: RendererHandle, opts: PublishOpts): string {
    const lines: string[] = []

    lines.push("")
    lines.push(header(r, { title: "Publishing", subtitle: opts.name, href: registryUrl(opts.name) }))
    lines.push("")
    lines.push(...steps(r, opts.steps, opts.frame !== undefined ? { frame: opts.frame } : {}))

    if (opts.result) {
        lines.push("")
        lines.push(...rows(r, [
            { label: "Version", value: opts.result.version, arrow: false },
            { label: "Access", value: opts.result.visibility, arrow: false },
            ...(opts.result.registeredId
                ? [{ label: "Registry", value: opts.result.registeredId, arrow: false }]
                : []),
        ]))

        if (opts.result.assets?.length) {
            lines.push("")
            lines.push(...results(r, opts.result.assets.map(asset => ({
                name: asset.path,
                outcome: asset.from ? ("ok" as const) : ("noop" as const),
                detail: asset.size,
                ...(asset.from ? { note: `from ${asset.from}` } : {}),
            }))))
        }

        lines.push("")
        const published = `${opts.name}@${opts.result.version}`
        lines.push(status(
            r,
            "ok",
            r.links
                ? `published ${hyperlink(registryUrl(opts.name), published)}`
                : `published ${published}`,
            opts.result.ms !== undefined ? `${(opts.result.ms / 1000).toFixed(1)}s` : undefined,
        ))
    }

    if (opts.failure) {
        lines.push("")
        lines.push(...errorReport(r, opts.failure.error, {
            ...(opts.failure.hint ? { hint: opts.failure.hint } : {}),
        }))
    }

    lines.push("")
    return lines.join("\n")
}

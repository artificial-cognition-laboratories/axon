/**
 * install — what `axon install <module>...` shows.
 *
 *     Installing into zeno
 *
 *     ✓ @cody/obsidian  0.4.2  installed
 *     ✓ @axon/github    1.1.0  installed
 *     · @cody/notion    0.2.0  already installed
 *
 *     ✓ Generating types  840ms
 *
 *     ✓ installed 2 modules in 3.4s
 *
 *     ➜  axon dev
 *
 * ── A batch, not a sequence ────────────────────────────────────────────────
 *
 * Every other long-running view in this package is a fixed list of steps. This
 * one is a set of user-supplied items each carrying its own verdict, which is
 * what `results` exists for — see that file for why "already installed" being
 * visually distinct from "installed" is the whole point.
 *
 * ── A partial batch is reported, not thrown away ───────────────────────────
 *
 * The command this replaces threw on the first bad result, which meant a batch
 * where the third of four names was mistyped reported an error and nothing
 * else — while the first two were already written to package.json and
 * installed on disk. The user was told it failed and left to guess what state
 * their project was in. Here every row is shown whatever happened, and the
 * summary says how many failed; the caller still exits non-zero.
 *
 * ── Types are regenerated here ─────────────────────────────────────────────
 *
 * The old output ended by telling the user to run `axon prepare` — once per
 * module, so a batch of three said it three times. An install that leaves the
 * type frame stale is half-finished, and "now run this other command" is a
 * chore being handed back. It is a step in this view instead.
 */

import { header, next, results, status, steps, summarize, type Result, type Step } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"
import { registryUrl } from "./publish.ts"

export type InstallOpts = {
    /**
     * The agent being installed into, by its scoped registry name
     * ("@cody/zeno") rather than its directory basename.
     *
     * The scoped name is the agent's actual identity — the same string the
     * registry, `axon publish` and `axon deploy` all use — so a bare "zeno"
     * here would be the one place in the product naming it differently.
     */
    agent: string
    /** One row per requested module. */
    modules: Result[]
    /**
     * The type-regeneration step, once the modules have resolved.
     *
     * Separate from `modules` because it is not one of them — it is a single
     * piece of work that happens after the batch, and folding it into the list
     * would make it look like another package.
     */
    prepare?: Step
    frame?: string
    result?: {
        ms?: number
        /** What to run next. Omitted when the batch failed. */
        next?: string
    }
}

export function install(r: RendererHandle, opts: InstallOpts): string {
    const lines: string[] = []

    lines.push("")
    lines.push(header(r, { title: "Installing into", subtitle: opts.agent, href: registryUrl(opts.agent) }))
    lines.push("")
    lines.push(...results(r, opts.modules, opts.frame !== undefined ? { frame: opts.frame } : {}))

    if (opts.prepare) {
        lines.push("")
        lines.push(...steps(r, [opts.prepare], opts.frame !== undefined ? { frame: opts.frame } : {}))
    }

    if (opts.result) {
        const summary = summarize(opts.modules, { verb: "installed", noun: "module" })

        // Duration is reported only when something was DONE. "nothing to do in
        // 0.5s" times a lookup nobody asked about, and a failure's duration is
        // the least interesting fact on the screen.
        const worked = opts.modules.some(m => m.outcome === "ok")
        const elapsed = worked && opts.result.ms !== undefined
            ? ` in ${(opts.result.ms / 1000).toFixed(1)}s`
            : ""

        lines.push("")
        lines.push(status(r, summary.ok ? "ok" : "fail", `${summary.text}${elapsed}`))

        if (opts.result.next) {
            lines.push("")
            lines.push(next(r, opts.result.next))
        }
    }

    lines.push("")
    return lines.join("\n")
}

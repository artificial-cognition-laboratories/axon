/**
 * clone — copy a published artifact into a directory.
 *
 *     Cloning @axon/obsidian
 *
 *     ✓ Resolving     180ms   1.4.0
 *     ✓ Downloading   640ms   248 KB
 *     ✓ Extracting    120ms
 *     ✓ Preparing     1.9s
 *
 *     ✓ cloned in 2.8s
 *
 *     ./obsidian
 *       ├─ src
 *       │   └─ index.ts
 *       └─ module.config.ts
 *
 *     ➜  cd obsidian && axon dev
 *
 * ── Shares init's ending, not its middle ───────────────────────────────────
 *
 * The finish is deliberately identical to `init`: both put a working project
 * on disk, and the questions afterwards are the same two — what did I get, and
 * what do I run. Two different answers to that would be two things to learn
 * for no reason.
 *
 * The middle is where they diverge. Init makes something from a template;
 * clone fetches something that already exists, so it has a resolve step (the
 * name might not exist, the version might not) and a download (the one place
 * in the product with a real byte count). Those are the failure modes worth
 * showing, and init has neither.
 *
 * ── `fork` is this view plus one fact ──────────────────────────────────────
 *
 * A fork is a clone that rewrites the package name and records what it came
 * from. That is one extra row, not a second view.
 */

import { header, next, status, steps, tree, errorReport, type Step, type TreeNode } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"
import { registryUrl } from "./publish.ts"

/** The steps a clone moves through, in order. */
export const CLONE_STEPS = ["Resolving", "Downloading", "Extracting", "Preparing"] as const

export type CloneOpts = {
    /** What is being cloned, by its registry name. */
    source: string
    /**
     * The name it lands as, when that differs — a fork renames it.
     *
     * Present only for a fork, and it is the whole visible difference between
     * the two commands.
     */
    as?: string
    steps: Step[]
    frame?: string
    result?: {
        /** The resolved version that actually landed. */
        version: string
        /** Where it landed, relative — `./obsidian`. */
        root: string
        files: TreeNode[]
        next?: string
        ms?: number
    }
    failure?: {
        error: AxonErrorLike
        hint?: string
    }
}

export function clone(r: RendererHandle, opts: CloneOpts): string {
    const lines: string[] = []

    lines.push("")
    lines.push(header(r, {
        title: opts.as ? "Forking" : "Cloning",
        subtitle: opts.source,
        href: registryUrl(opts.source),
    }))

    // Stated up front rather than at the end: it changes what the whole
    // operation produces, and a user who typed the wrong `--as` wants to know
    // before the download than after it.
    if (opts.as) {
        lines.push("")
        lines.push(r.c.dim(`as ${opts.as}`))
    }

    lines.push("")
    lines.push(...steps(r, opts.steps, opts.frame !== undefined ? { frame: opts.frame } : {}))

    if (opts.result) {
        lines.push("")
        lines.push(status(
            r,
            "ok",
            // The resolved version is named here because it is not necessarily
            // the one asked for — `axon clone @axon/obsidian` takes latest, and
            // which latest turned out to be is the fact worth recording.
            `${opts.as ? "forked" : "cloned"} ${opts.as ?? opts.source}@${opts.result.version}`,
            opts.result.ms !== undefined ? `${(opts.result.ms / 1000).toFixed(1)}s` : undefined,
        ))

        lines.push("")
        lines.push(r.c.primary(opts.result.root))
        lines.push(...tree(r, opts.result.files, { counts: false, files: true, indent: 2 }))

        if (opts.result.next) {
            lines.push("")
            lines.push(next(r, opts.result.next))
        }
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

/**
 * Bytes as a human reads them — "248 KB", "1.2 MB".
 *
 * Binary units (1024) because that is what a file size is, but labelled the
 * way every OS labels them rather than as KiB, which is correct and which
 * nobody says out loud.
 */
export function bytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

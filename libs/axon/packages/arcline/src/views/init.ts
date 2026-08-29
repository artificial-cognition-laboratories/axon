/**
 * init — what `axon <kind> init <name>` shows while it scaffolds a project.
 *
 *     Creating agent zeno
 *
 *     ✓ Scaffolding    120ms
 *     ✓ Installing     3.1s
 *     ✓ Generating     840ms
 *
 *     ✓ created in 4.1s
 *
 *     zeno
 *     ├─ axon.config.ts
 *     ├─ package.json
 *     ├─ bunfig.toml
 *     └─ src
 *        └─ boot.vue
 *
 *     ➜  cd zeno && axon dev
 *
 * ── The two things init has to do that other views do not ──────────────────
 *
 * It shows the SHAPE of what was made, not a list of what was installed. The
 * old output ended with "installed @arcforge/types + @arcforge/engines,
 * generated .agent/" — implementation trivia about a directory the user will
 * never open. A tree of the files that now exist teaches the layout at the one
 * moment the user is most receptive to learning it, and it is honest, because
 * it is what is actually on disk.
 *
 * And it ends with the NEXT COMMAND. init is usually the first thing anyone
 * runs, so the highest-value line in the whole view is the one that says what
 * to type next — which the previous version did not have at all.
 *
 * The kind is in the header because there are seven of them and `axon init`
 * and `axon module init` make very different things. Naming it makes the
 * multi-kind system legible rather than something to be remembered.
 */

import { header, next, status, steps, tree, errorReport, type Step, type TreeNode } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"

/** The steps a scaffold moves through, in order. */
export const INIT_STEPS = ["Scaffolding", "Installing", "Generating"] as const

export type InitOpts = {
    /** The project kind — agent, module, cognet, bench, prompt, extension. */
    kind: string
    /** The project name. Absent while it is still being asked for. */
    name?: string
    steps: Step[]
    frame?: string
    result?: {
        /** The scaffolded structure, rooted at the project directory. */
        files: TreeNode[]
        /** Absolute path, for the record. */
        root: string
        /** What to run next, e.g. "cd zeno && axon dev". */
        next?: string
        ms?: number
    }
    failure?: {
        error: AxonErrorLike
        hint?: string
    }
}

export function init(r: RendererHandle, opts: InitOpts): string {
    const lines: string[] = []

    lines.push("")
    lines.push(header(r, {
        title: `Creating ${opts.kind}`,
        ...(opts.name ? { subtitle: opts.name } : {}),
    }))
    lines.push("")
    lines.push(...steps(r, opts.steps, opts.frame !== undefined ? { frame: opts.frame } : {}))

    if (opts.result) {
        lines.push("")
        lines.push(status(
            r,
            "ok",
            opts.result.ms !== undefined
                ? `created in ${(opts.result.ms / 1000).toFixed(1)}s`
                : "created",
        ))

        // Rendered with the leading `./` — a bare name is ambiguous with the
        // project's own name (they are the same word), while `./zeno` can only
        // be a directory, which is what the tree beneath it is showing.
        lines.push("")
        lines.push(r.c.primary(opts.result.root))
        lines.push(...tree(r, opts.result.files, { counts: false, files: true, indent: 2 }))

        // The most valuable line in the view, and the reason it is last: it is
        // where the eye stops.
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

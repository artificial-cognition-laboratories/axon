/**
 * hello — the reference view. The smallest thing that proves the shape.
 *
 * Every view is `(renderer, opts) => string`: pure, no printing, no cursor.
 * The caller decides where the string goes — stdout, a snapshot test, a
 * buffer. Interactive surfaces (spinners, prompts) are a different kind and
 * live elsewhere; they own the cursor, so they cannot be pure functions.
 */

import { header, status } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type HelloOpts = {
    /** Who to greet. */
    name?: string
}

export function hello(r: RendererHandle, opts: HelloOpts = {}): string {
    return [
        "",
        header(r, { title: "@arcforge/arcline", subtitle: "— unified CLI rendering for Axon" }),
        "",
        status(r, "ok", `hello, ${opts.name ?? "world"}`),
        "",
    ].join("\n")
}

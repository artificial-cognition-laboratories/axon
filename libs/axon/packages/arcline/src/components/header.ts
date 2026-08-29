/**
 * header — the title block a surface opens with.
 *
 *   Axon dev server
 *
 * Title in primary + bold, an optional dimmed subtitle trailing it on the same
 * line. Deliberately not a box: a rule or a border costs two lines and says
 * nothing a weight change doesn't.
 */

import { hyperlink } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type HeaderOpts = {
    title: string
    /** Trailing context, dimmed — e.g. "dev server", "v2.0.158". */
    subtitle?: string
    /** Makes the subtitle a clickable link, without changing how it reads. */
    href?: string
}

export function header(r: RendererHandle, opts: HeaderOpts): string {
    const title = r.c.bold(r.c.primary(opts.title))
    if (!opts.subtitle) return title

    const painted = r.c.dim(opts.subtitle)
    const subtitle = opts.href && r.links ? hyperlink(opts.href, painted) : painted
    return `${title} ${subtitle}`
}

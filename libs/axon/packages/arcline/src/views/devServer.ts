/**
 * devServer — the block a long-running `axon dev` prints once it is up.
 *
 * Composed entirely from components; this file contains layout decisions and
 * nothing else, which is what a view is.
 *
 *     Axon dev server
 *
 *     ➜  Agent:    @cody/zeno
 *        Model:    claude-opus-5
 *        Modules:  obsidian, github, linear
 *
 *     ➜  Local:    http://localhost:3141
 *     ➜  Debug:    http://localhost:3141/__debug
 *     ➜  Runtime:  ws://localhost:3141/ws
 *
 *     ✓ ready in 412ms
 *
 * ── The three groups ───────────────────────────────────────────────────────
 *
 * What the agent IS, where you can GO, and how it WENT. They are separated by
 * blank lines rather than headings because three short groups need no labels
 * to be told apart, and the identity group comes first: you confirm you booted
 * the right thing before you click into it.
 */

import { header, rows, status, type Row } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type DevServerOpts = {
    /** Product title, e.g. "Axon". */
    title: string
    /** What the server IS — agent name, model, loaded modules. */
    info?: Array<[label: string, value: string]>
    /**
     * Every URL this server exposes, the bound address included.
     *
     * One group, because they are one KIND of fact: somewhere you can go. The
     * bound URL is not special enough to separate — it is simply the first
     * link, and the caller decides its label. Values are absolute; joining a
     * path to the bound port is the caller's job, since only it knows what it
     * bound.
     */
    links?: Array<[label: string, url: string]>
    /** Milliseconds to ready. */
    readyMs?: number
}

export function devServer(r: RendererHandle, opts: DevServerOpts): string {
    const lines: string[] = []

    lines.push("")
    lines.push(header(r, { title: opts.title, subtitle: "dev server" }))
    lines.push("")

    // Both groups share one alignment width so the value column is a single
    // straight edge down the whole block — computed across them, then rendered
    // separately so the blank line between does not reset it.
    const info: Row[] = (opts.info ?? []).map(([label, value], i) => ({
        label,
        value,
        arrow: i === 0,
    }))
    const links: Row[] = (opts.links ?? []).map(([label, url]) => ({ label, value: url, href: url }))

    const labelWidth = Math.max(...[...info, ...links].map(i => i.label.length))

    if (info.length) lines.push(...rows(r, info, { labelWidth }))
    if (info.length && links.length) lines.push("")
    if (links.length) lines.push(...rows(r, links, { labelWidth }))

    lines.push("")
    lines.push(status(r, "ok", opts.readyMs !== undefined ? `ready in ${opts.readyMs}ms` : "ready"))
    lines.push("")

    return lines.join("\n")
}

/**
 * tree — nested structure with box-drawing connectors.
 *
 *   ├─ events (2)
 *   │  ├─ user:message
 *   │  └─ agent:message
 *   └─ pathways (1)
 *      └─ api/chat
 *
 * Used wherever a surface shows what something CONTAINS — a blueprint's
 * registrations, a deployment's steps, a module's exports.
 */

import { icons, hyperlink, width } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type TreeNode = {
    label: string
    /** Trailing detail, dimmed — a value, a count, a status. */
    note?: string
    /** Makes the label a clickable link. */
    href?: string
    children?: TreeNode[]
}

export type TreeOpts = {
    /**
     * Indent every line by this many spaces.
     *
     * A file tree sits under its root path, and hanging the connectors flush
     * with that path makes the root read as another sibling rather than as the
     * thing containing them.
     */
    indent?: number
    /**
     * Show `(n)` after any node with children. Default true — a count is the
     * one piece of information a collapsed subtree can still convey.
     */
    counts?: boolean
    /**
     * Sort as a file explorer would: directories first, then natural order.
     *
     * Off by default, because most trees in this package show a SEQUENCE — a
     * blueprint's registrations, a set of steps — where the given order is the
     * information and sorting it would destroy that. A filesystem is the case
     * where order is arbitrary and a familiar one helps.
     */
    files?: boolean
}

export function tree(r: RendererHandle, nodes: TreeNode[], opts: TreeOpts = {}): string[] {
    const roots = opts.files ? sortFiles(nodes) : nodes
    const pad = " ".repeat(opts.indent ?? 0)
    return render(r, roots, pad, 0, opts.counts ?? true, noteColumn(roots), opts.files ?? false)
}

/**
 * VS Code's Explorer order: directories before files, then a case-insensitive
 * natural comparison so `boot2.vue` precedes `boot10.vue`.
 *
 * Matched deliberately rather than approximated. This tree is read by someone
 * who spends all day in an editor sidebar, and a listing that orders the same
 * files differently costs them a scan every time they look for one.
 */
function sortFiles(nodes: TreeNode[]): TreeNode[] {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

    return [...nodes].sort((a, b) => {
        const aDir = Boolean(a.children)
        const bDir = Boolean(b.children)
        if (aDir !== bDir) return aDir ? -1 : 1
        return collator.compare(a.label, b.label)
    })
}

/**
 * The column notes align to, measured across SIBLINGS at every depth.
 *
 * A note butted against a label of whatever length happens to precede it reads
 * as part of the name. Giving notes their own column turns them into an
 * annotation the eye can skip or read as a group, which is the only reason to
 * have them.
 */
function noteColumn(nodes: TreeNode[]): number {
    let widest = 0
    for (const node of nodes) {
        if (node.note) widest = Math.max(widest, width(node.label))
    }
    return widest
}

function render(
    r: RendererHandle,
    nodes: TreeNode[],
    prefix: string,
    depth: number,
    counts: boolean,
    noteAt: number,
    files: boolean,
): string[] {
    const lines: string[] = []

    nodes.forEach((node, i) => {
        const last = i === nodes.length - 1
        const connector = r.c.faint(last ? icons.elbow : icons.tee)

        // The continuation prefix for this node's children: a pipe if more
        // siblings follow (the subtree is still "inside" the list), blank if
        // this was the last one.
        //
        // Indented one column WIDER than the connector it hangs under, so a
        // child sits clearly inside its parent rather than almost beneath it.
        // At the tighter indent the level change was too small to catch and
        // the whole tree read as one flat run — which a blank line between
        // subtrees papered over without fixing.
        const childPrefix = prefix + (last ? "    " : r.c.faint(icons.pipe) + "   ")

        // What carries weight differs by what the tree IS.
        //
        // In a file listing, structure is the DIRECTORY — a folder is a place
        // you can go, a file is a leaf, and depth means nothing (a file at the
        // root is no more important than one three levels down). Elsewhere the
        // tree is a sequence of sections whose top level is the heading.
        //
        // Either way only one class of node is bright. A tree where everything
        // is lit has no hierarchy at all, which is what makes the eye scan the
        // whole thing instead of landing on the shape.
        const structural = files ? Boolean(node.children) : depth === 0

        // Three levels, not two: connectors are dim scaffolding, leaves are
        // readable body text, structure is bright. Collapsing leaves to dim
        // put them at the same weight as the box-drawing characters, which
        // made the names themselves hard to pick out.
        const painted = structural ? r.c.primary(node.label) : r.c.text(node.label)
        const label = node.href && r.links ? hyperlink(node.href, painted) : painted

        const count = counts && node.children?.length ? r.c.dim(` (${node.children.length})`) : ""

        // Notes start at a shared column so they read as a second field rather
        // than as more of the name.
        const note = node.note
            ? " ".repeat(Math.max(1, noteAt - width(node.label) + 2)) + r.c.dim(node.note)
            : ""

        lines.push(`${prefix}${connector} ${label}${count}${note}`)

        if (node.children?.length) {
            const children = files ? sortFiles(node.children) : node.children
            lines.push(...render(r, children, childPrefix, depth + 1, counts, noteColumn(children), files))
        }
    })

    return lines
}

/**
 * search — the registry, queried.
 *
 *     obsidian  ·  4 results
 *
 *     @axon/obsidian                      module  1.4.0
 *       Read and write an Obsidian vault from your agent.
 *                                                ★ 42  ↓ 1.2k
 *
 * ── A miss is an answer ────────────────────────────────────────────────────
 *
 * An empty result set is not a failure and must not be dressed as one: the
 * registry answered, and the answer is "nothing". It renders as a quiet line
 * with the query echoed back — which is also the most useful thing to show,
 * since the commonest cause of a miss is a typo the user cannot see in their
 * own scrollback.
 *
 * The exit code stays 0 for the same reason, and that is load-bearing rather
 * than pedantic: an agent asking "is there an Obsidian module" and receiving a
 * non-zero exit reads it as a broken command rather than as "no".
 *
 * ── The header states the query ────────────────────────────────────────────
 *
 * A list of results with no restatement of what was asked is unreadable in
 * scrollback ten seconds later, and `axon search` supports enough narrowing
 * flags — kind, scope, sort — that "these are the results for X" is genuinely
 * not obvious from the rows alone.
 */

import { entries, next, type Entry } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type SearchOpts = {
    /** What was searched for. Absent for a bare `axon list`. */
    query?: string
    /** Active narrowing, e.g. ["module", "@axon"] — echoed so the answer is legible. */
    filters?: string[]
    results: Entry[]
    /**
     * Total matches when more exist than are shown, so a truncated list says
     * so rather than implying it is the whole answer.
     */
    total?: number
    /** Shown under an empty result set. */
    suggestion?: string
}

export function search(r: RendererHandle, opts: SearchOpts): string {
    const lines: string[] = []

    lines.push("")
    lines.push(headline(r, opts))
    lines.push("")

    if (opts.results.length === 0) {
        lines.push(r.c.dim("no matches"))
        if (opts.suggestion) {
            lines.push("")
            lines.push(next(r, opts.suggestion))
        }
        lines.push("")
        return lines.join("\n")
    }

    lines.push(...entries(r, opts.results))

    if (opts.total !== undefined && opts.total > opts.results.length) {
        lines.push("")
        lines.push(r.c.dim(`showing ${opts.results.length} of ${opts.total} — narrow with --kind, --scope or --limit`))
    }

    lines.push("")
    return lines.join("\n")
}

/**
 * `Search  obsidian · module · 4 results`
 *
 * The verb is stated because the query alone does not say what happened to it.
 * A bare `obsidian · 4 results` at the top of a scrollback could be a search,
 * a filter, a cached listing — and the whole point of echoing the query is to
 * make the answer legible later, which fails if the operation is ambiguous.
 * Every other view in this package names itself the same way ("Publishing",
 * "Deploying", "Installing into"); this one was the exception.
 *
 * One line rather than a header plus rows: everything here is the same kind of
 * fact — what was asked — and stacking them would give the question more
 * vertical space than any single answer beneath it.
 */
function headline(r: RendererHandle, opts: SearchOpts): string {
    const count = opts.results.length === 0
        ? "no results"
        : `${opts.total ?? opts.results.length} ${(opts.total ?? opts.results.length) === 1 ? "result" : "results"}`

    // A query-less `axon list` is browsing, not searching, and saying "Search"
    // over a catalogue nobody queried would be a small lie.
    const verb = opts.query ? "Search" : "Registry"

    const facts = [
        ...(opts.query ? [r.c.text(opts.query)] : []),
        ...(opts.filters ?? []).map(f => r.c.dim(f)),
        r.c.dim(count),
    ]

    return `${r.c.bold(r.c.primary(verb))}  ${facts.join(r.c.faint("  ·  "))}`
}

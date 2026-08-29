import { ARTIFACT_KINDS, type ArtifactKind, type ArtifactRecord } from "./types"

/**
 * How results are ordered.
 *
 * `relevance` is the SERVER's order and the only one it can express: full-text
 * rank, then trigram similarity on the name, then stars. Browsing with no query
 * scores every row zero, so the server falls back to stars-then-name — which is
 * why `relevance` and `stars` are the same request and differ only in whether a
 * query was supplied.
 *
 * The other three are applied HERE, over the complete result set. That is the
 * load-bearing part: the backend pages at 20 and offers no `?sort=`, so sorting
 * one page by installs and calling it "top by installs" would be a lie about
 * the whole registry. `search()` pages to completion before this runs, and
 * `limit` is applied AFTER the sort for the same reason — cutting first would
 * sort an arbitrary subset.
 *
 * When the backend grows `?sort=`, these move server-side and this vocabulary
 * does not change.
 */
export const SORT_ORDERS = ["relevance", "stars", "installs", "name", "recent"] as const

export type SortOrder = (typeof SORT_ORDERS)[number]

export type SearchInput = {
    /** Free text. Matched by the server against name, description and README. */
    query?: string
    /** Narrow to these kinds. Empty or omitted searches every kind. */
    kind?: ArtifactKind | ArtifactKind[]
    /**
     * Only artifacts under this namespace — "@axon" or "axon", both accepted.
     *
     * Filtered client-side: the catalog endpoint has no owner parameter. Matched
     * against the artifact's own scoped NAME rather than its owner columns,
     * because the name is the identity (`ownerUsername`/`orgSlug` are
     * authorization facts and disagree with the scope for an org-owned artifact
     * published under a user's namespace).
     */
    scope?: string
    /** Maximum results returned. Applied after sorting. */
    limit?: number
    /** Defaults to `relevance` — which, with no query, is the server's stars-then-name catalogue order. */
    sort?: SortOrder
}

/** Normalize "@axon" / "axon" / "@axon/" to the "@axon/" prefix a name carries. */
function scopePrefix(scope: string): string {
    const bare = scope.replace(/^@/, "").replace(/\/$/, "")
    return `@${bare}/`
}

/**
 * Narrow a full result set to one scope.
 *
 * Case-insensitive: scoped names are lowercase by convention, and a user
 * typing `--scope @Axon` means the same namespace.
 */
export function filterByScope(items: ArtifactRecord[], scope: string): ArtifactRecord[] {
    const prefix = scopePrefix(scope).toLowerCase()
    return items.filter(item => item.name.toLowerCase().startsWith(prefix))
}

/**
 * Order a complete result set.
 *
 * `relevance` returns the input untouched — the server already ranked it, and
 * re-sorting would discard exactly the signal that ordering exists to carry.
 *
 * Every comparator has a NAME TIEBREAK, for the same reason the backend's
 * `CATALOG_ORDER` does: most artifacts have zero stars and zero installs, so
 * without a second key the order within a tie is whatever the input happened to
 * be, and two identical searches can disagree.
 */
export function sortResults(items: ArtifactRecord[], sort: SortOrder): ArtifactRecord[] {
    if (sort === "relevance") return items

    const byName = (a: ArtifactRecord, b: ArtifactRecord) => a.name.localeCompare(b.name)
    const sorted = [...items]

    switch (sort) {
        case "stars":
            return sorted.sort((a, b) => b.starsCount - a.starsCount || byName(a, b))
        case "installs":
            return sorted.sort((a, b) => b.installsCount - a.installsCount || byName(a, b))
        case "name":
            return sorted.sort(byName)
        case "recent":
            // Newest first. `createdAt` is an ISO-8601 string from the server,
            // which sorts lexicographically in the same order it sorts
            // chronologically — no Date parsing needed, and no invalid-date
            // NaN to poison the comparator.
            return sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || byName(a, b))
    }
}

/**
 * Apply scope, sort and limit to a complete result set, in that order.
 *
 * The ORDER of the three is the contract: filter narrows what is being ranked,
 * sort ranks all of it, and only then does the limit take a prefix. Any other
 * arrangement answers a different question than the one asked — limiting first
 * makes `--sort installs --limit 5` report the top five of an arbitrary twenty
 * rather than of the registry.
 */
export function refine(items: ArtifactRecord[], input: SearchInput): ArtifactRecord[] {
    const scoped = input.scope ? filterByScope(items, input.scope) : items
    const ordered = sortResults(scoped, input.sort ?? "relevance")
    return input.limit !== undefined ? ordered.slice(0, input.limit) : ordered
}

/**
 * Validate a caller-supplied kind list, naming what was wrong.
 *
 * Checked HERE rather than left to the backend's 400 so the CLI can answer a
 * typo without a round trip, and so an agent gets the valid vocabulary back in
 * the error instead of having to already know it.
 */
export function parseKinds(raw: string): ArtifactKind[] {
    const requested = raw.split(",").map(k => k.trim()).filter(k => k.length > 0)
    const invalid = requested.filter(k => !ARTIFACT_KINDS.includes(k as ArtifactKind))
    if (invalid.length > 0) {
        throw new Error(
            `unknown kind: ${invalid.join(", ")} — expected one of ${ARTIFACT_KINDS.join(", ")}`,
        )
    }
    return requested as ArtifactKind[]
}

/** Validate a caller-supplied sort order, naming the alternatives. */
export function parseSort(raw: string): SortOrder {
    if (!SORT_ORDERS.includes(raw as SortOrder)) {
        throw new Error(`unknown sort: ${raw} — expected one of ${SORT_ORDERS.join(", ")}`)
    }
    return raw as SortOrder
}

/**
 * Validate a caller-supplied limit.
 *
 * Rejects rather than clamps. A limit of `0`, `-3` or `abc` is a mistake in the
 * caller's command, and silently substituting 20 would answer a question nobody
 * asked while looking like it worked.
 */
export function parseLimit(raw: string): number {
    const limit = Number(raw)
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`invalid limit: ${raw} — expected a positive whole number`)
    }
    return limit
}

import { queryArxiv, fetchByIds } from "../arxiv/client.ts"
import type { QueryOptions } from "../arxiv/client.ts"

export type { Paper } from "../arxiv/client.ts"

// ── Public surface ─────────────────────────────────────────────────────────────

export const arxiv = {
    /**
     * Search arXiv papers using Lucene query syntax.
     *
     * **Field prefixes:**
     * - `ti:` — title
     * - `au:` — author (last name or full name)
     * - `abs:` — abstract
     * - `cat:` — category (e.g. `cat:cs.LG`)
     * - `all:` — all fields (default when no prefix)
     *
     * **Operators:** `AND`, `OR`, `NOT`. Phrases must be quoted.
     *
     * Tip: use `sortBy: "submittedDate"` for latest papers in a field.
     * Tip: quote multi-word phrases — `ti:"attention is all you need"`.
     *
     * @example
     * const { papers, total } = await arxiv.search("ti:\"attention is all you need\"")
     * // → { papers: [{ id: "1706.03762", title: "Attention Is All You Need", ... }], total: 1 }
     *
     * @example
     * const { papers } = await arxiv.search("au:LeCun AND cat:cs.LG", { sortBy: "submittedDate", limit: 5 })
     */
    async search(query: string, opts: QueryOptions = {}): Promise<{ papers: import("../arxiv/client.ts").Paper[]; total: number }> {
        return queryArxiv(query, opts)
    },

    /**
     * Fetch one or more papers by arXiv ID.
     *
     * Accepts bare IDs with or without version suffix:
     * - `"1706.03762"` — resolves to latest version
     * - `"1706.03762v7"` — resolves to exact version
     *
     * Most efficient way to retrieve papers when you already have IDs —
     * batch up to 100 in a single call.
     *
     * @example
     * const papers = await arxiv.fetch(["1706.03762", "2006.16189"])
     * // → [{ id: "1706.03762", title: "Attention Is All You Need", ... }, ...]
     */
    async fetch(ids: string[]): Promise<import("../arxiv/client.ts").Paper[]> {
        return fetchByIds(ids)
    },

    /**
     * Get one paper by arXiv ID. Returns null if the ID is not found.
     *
     * @example
     * const paper = await arxiv.get("1706.03762")
     * // → { id: "1706.03762", title: "Attention Is All You Need", abstract: "...", ... }
     */
    async get(id: string): Promise<import("../arxiv/client.ts").Paper | null> {
        const results = await fetchByIds([id])
        return results[0] ?? null
    },

    /**
     * Get the latest papers in a category.
     *
     * Category examples: `cs.LG`, `cs.AI`, `cs.CL`, `cs.CV`, `cs.NE`,
     * `stat.ML`, `math.OC`, `q-bio.NC`, `econ.GN`.
     *
     * @example
     * const papers = await arxiv.recent("cs.LG", 10)
     * // → [{ id: "...", title: "...", publishedAt: "2026-06-24T...", ... }, ...]
     */
    async recent(category: string, limit = 10): Promise<import("../arxiv/client.ts").Paper[]> {
        const { papers } = await queryArxiv(`cat:${category}`, {
            limit,
            sortBy: "submittedDate",
            sortOrder: "descending",
        })
        return papers
    },

    /**
     * Search papers by author name. Use last name for broad results,
     * or `"Firstname Lastname"` for exact matching.
     *
     * @example
     * const papers = await arxiv.byAuthor("Hinton", { limit: 20 })
     * // → [{ id: "...", authors: ["Geoffrey Hinton", ...], ... }, ...]
     */
    async byAuthor(author: string, opts: Omit<QueryOptions, "sortBy" | "sortOrder"> = {}): Promise<import("../arxiv/client.ts").Paper[]> {
        const query = author.includes(" ") ? `au:"${author}"` : `au:${author}`
        const { papers } = await queryArxiv(query, {
            ...opts,
            sortBy: "submittedDate",
            sortOrder: "descending",
        })
        return papers
    },

    /**
     * Search for papers matching a concept in their title or abstract,
     * optionally filtered to a category.
     *
     * Handles Lucene phrase quoting automatically — just pass natural text.
     *
     * @example
     * const papers = await arxiv.about("diffusion models", { category: "cs.CV", limit: 15 })
     */
    async about(concept: string, opts: { category?: string; limit?: number; offset?: number } = {}): Promise<import("../arxiv/client.ts").Paper[]> {
        const phrase = concept.trim().includes(" ") ? `"${concept.trim()}"` : concept.trim()
        const base = `ti:${phrase} OR abs:${phrase}`
        const query = opts.category ? `(${base}) AND cat:${opts.category}` : base
        const { papers } = await queryArxiv(query, {
            limit: opts.limit,
            offset: opts.offset,
            sortBy: "relevance",
        })
        return papers
    },

    /**
     * Search for papers in a date range. Dates are inclusive UTC boundaries.
     *
     * Combine with a query string or leave it empty to get all papers in the range.
     *
     * @example
     * const papers = await arxiv.since("2026-01-01", "2026-06-25", "cat:cs.AI", { limit: 50 })
     */
    async since(
        from: string,
        to: string,
        query = "cat:cs.AI",
        opts: Omit<QueryOptions, "sortBy" | "sortOrder"> = {},
    ): Promise<import("../arxiv/client.ts").Paper[]> {
        // arXiv date format: YYYYMMDDHHmm
        const fmt = (d: string) => d.replace(/[-T:Z]/g, "").slice(0, 12).padEnd(12, "0")
        const dateClause = `submittedDate:[${fmt(from)} TO ${fmt(to)}]`
        const fullQuery = query ? `(${query}) AND ${dateClause}` : dateClause
        const { papers } = await queryArxiv(fullQuery, {
            ...opts,
            sortBy: "submittedDate",
            sortOrder: "descending",
        })
        return papers
    },
}

export type GoogleSearchOptions = {
    /** Number of results to return. Default 5, max 10 (API ceiling). */
    count?: number
    /** Restrict results to a specific domain, e.g. "github.com". */
    site?: string
    /** Enable safe search. Default true. */
    safe?: boolean
}

export type SearchResult = {
    title: string
    url: string
    snippet: string
}

export type SearchResponse = {
    /** The query as Google interpreted it (may differ from input). */
    query: string
    /** Estimated total number of results across all pages. */
    total: number
    /** Results for this request. */
    items: SearchResult[]
}

/**
 * Search the web using Google Custom Search.
 *
 * Requires GOOGLE_API_KEY and GOOGLE_CSE_ID in the agent's environment.
 *
 * ```ts
 * const results = await google.search("bun javascript runtime")
 * const results = await google.search("TypeScript decorators", { count: 3, site: "github.com" })
 * ```
 */
export async function search(query: string, opts: GoogleSearchOptions = {}): Promise<SearchResponse> {
    const apiKey = process.env.GOOGLE_API_KEY
    const cseId = process.env.GOOGLE_CSE_ID

    if (!apiKey) throw new Error("GOOGLE_API_KEY is not set")
    if (!cseId) throw new Error("GOOGLE_CSE_ID is not set")

    const count = Math.min(opts.count ?? 5, 10)
    const q = opts.site ? `${query} site:${opts.site}` : query
    const safe = opts.safe !== false ? "active" : "off"

    const url = new URL("https://www.googleapis.com/customsearch/v1")
    url.searchParams.set("key", apiKey)
    url.searchParams.set("cx", cseId)
    url.searchParams.set("q", q)
    url.searchParams.set("num", String(count))
    url.searchParams.set("safe", safe)

    const res = await fetch(url)

    if (!res.ok) {
        const body = await res.text()
        throw new Error(`Google Search API error ${res.status}: ${body}`)
    }

    const data = await res.json() as GoogleCustomSearchResponse

    return {
        query: data.queries?.request?.[0]?.searchTerms ?? q,
        total: parseInt(data.searchInformation?.totalResults ?? "0", 10),
        items: (data.items ?? []).map((item) => ({
            title: item.title,
            url: item.link,
            snippet: item.snippet,
        })),
    }
}

// ── Raw API response types ────────────────────────────────────────────────────

type GoogleCustomSearchResponse = {
    searchInformation?: {
        totalResults?: string
    }
    queries?: {
        request?: Array<{ searchTerms?: string }>
    }
    items?: Array<{
        title: string
        link: string
        snippet: string
    }>
}

export type BraveSearchOptions = {
    /** Number of results to return. Default 5, max 20 (API ceiling). */
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
    /** The query as sent to Brave (after any site filter applied). */
    query: string
    /** Results for this request. */
    items: SearchResult[]
}


// ── Raw API response types ────────────────────────────────────────────────────

type BraveWebSearchResponse = {
    web?: {
        results?: Array<{
            title: string
            url: string
            description: string
        }>
    }
}

/**
 * Search the web using the Brave Search API.
 *
 * Requires BRAVE_API_KEY in the agent's environment.
 *
 * ```ts
 * const results = await brave.search("bun javascript runtime")
 * const results = await brave.search("TypeScript decorators", { count: 3, site: "github.com" })
 * ```
 */
export const brave = {
    async search(query: string, opts: BraveSearchOptions = {}): Promise<SearchResponse> {
        const apiKey = process.env.BRAVE_API_KEY

        if (!apiKey) throw new Error("BRAVE_API_KEY is not set")

        const count = Math.min(opts.count ?? 5, 20)
        const q = opts.site ? `${query} site:${opts.site}` : query
        const safesearch = opts.safe !== false ? "moderate" : "off"

        const url = new URL("https://api.search.brave.com/res/v1/web/search")
        url.searchParams.set("q", q)
        url.searchParams.set("count", String(count))
        url.searchParams.set("safesearch", safesearch)

        const res = await fetch(url, {
            headers: {
                Accept: "application/json",
                "X-Subscription-Token": apiKey,
            },
        })

        if (!res.ok) {
            const body = await res.text()
            throw new Error(`Brave Search API error ${res.status}: ${body}`)
        }

        const data = await res.json() as BraveWebSearchResponse

        return {
            query: q,
            items: (data.web?.results ?? []).map((item) => ({
                title: item.title,
                url: item.url,
                snippet: item.description,
            })),
        }
    }
}

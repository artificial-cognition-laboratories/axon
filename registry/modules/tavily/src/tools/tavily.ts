export type TavilySearchOptions = {
    /** Number of results to return. Default 5, max 20 (API ceiling). */
    count?: number
    /** Restrict results to a specific domain, e.g. "github.com". */
    site?: string
    /** "basic" is fast; "advanced" digs deeper at higher cost. Default "basic". */
    depth?: "basic" | "advanced"
}

export type SearchResult = {
    title: string
    url: string
    snippet: string
}

export type SearchResponse = {
    /** The query as sent to Tavily. */
    query: string
    /** Results for this request. */
    items: SearchResult[]
}


// ── Raw API response types ────────────────────────────────────────────────────

type TavilySearchApiResponse = {
    query: string
    results?: Array<{
        title: string
        url: string
        content: string
    }>
}

/**
 * Search the web using the Tavily Search API.
 *
 * Requires TAVILY_API_KEY in the agent's environment.
 *
 * ```ts
 * const results = await tavily.search("bun javascript runtime")
 * const results = await tavily.search("TypeScript decorators", { count: 3, site: "github.com" })
 * ```
 */
export const tavily = {
    async search(query: string, opts: TavilySearchOptions = {}): Promise<SearchResponse> {
        const apiKey = process.env.TAVILY_API_KEY

        if (!apiKey) throw new Error("TAVILY_API_KEY is not set")

        const count = Math.min(opts.count ?? 5, 20)

        const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                query,
                max_results: count,
                search_depth: opts.depth ?? "basic",
                include_domains: opts.site ? [opts.site] : undefined,
            }),
        })

        if (!res.ok) {
            const body = await res.text()
            throw new Error(`Tavily Search API error ${res.status}: ${body}`)
        }

        const data = await res.json() as TavilySearchApiResponse

        return {
            query: data.query,
            items: (data.results ?? []).map((item) => ({
                title: item.title,
                url: item.url,
                snippet: item.content,
            })),
        }
    }
}

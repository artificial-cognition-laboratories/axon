/**
 * Search providers — one row each, behind one shape.
 *
 * A provider is: a name, the env vars it needs, and a function from query to
 * results. That is the whole contract, and it is what makes adding a fourth
 * provider a row in the table below rather than a branch anywhere else.
 *
 * ── Why every provider returns the same type ────────────────────────────────
 *
 * The caller is an agent that wants to know things, not a client of any
 * particular search API. It must not have to know which provider answered —
 * otherwise "search the web" becomes "search the web with whichever key
 * happens to be set", and every prompt that uses it has to branch.
 *
 * So provider-specific concepts are erased here. Google's `total`, Tavily's
 * `search_depth`, Brave's `safesearch` — each is expressed in the shared
 * options where it has a meaning, and dropped where it does not.
 */

export type SearchResult = {
    title: string
    url: string
    snippet: string
}

export type SearchResponse = {
    /** The query as sent to whichever provider answered. */
    query: string
    items: SearchResult[]
    /** Which provider produced these — for debugging, never for branching. */
    provider: string
}

export type SearchOptions = {
    /** Results to return. Default 5. Each provider clamps to its own ceiling. */
    count?: number
    /** Restrict to one domain, e.g. "github.com". */
    site?: string
    /** Filter explicit results. Default true. Ignored by providers with no such control. */
    safe?: boolean
    /** Dig deeper at higher cost, where the provider supports it. Default false. */
    deep?: boolean
}

export type Provider = {
    /** Stable id — what `provider` in a response says, and what `only` accepts. */
    name: string
    /**
     * Env vars this provider needs, ALL of which must be set for it to be
     * usable. Google needs two; a provider missing one of them is skipped
     * rather than attempted and failed.
     */
    env: string[]
    search: (query: string, opts: SearchOptions) => Promise<SearchResponse>
}

/** True when every var this provider needs is present and non-empty. */
export function configured(provider: Provider): boolean {
    return provider.env.every(name => Boolean(process.env[name]))
}

// ── Providers, in cascade order ──────────────────────────────────────────────
//
// Order is preference, and it is deliberate rather than alphabetical:
//
//   tavily — built for agents. Returns prose extracts rather than SERP blurbs,
//            which is what a model can actually use.
//   brave  — a real independent index, one key, generous free tier.
//   google — the best index, but needs TWO secrets (key + CSE id) and a custom
//            search engine configured by hand, so it is the least likely to be
//            set and the most annoying to set up.
//
// A user who wants a different order sets only the key they want.

const tavily: Provider = {
    name: "tavily",
    env: ["TAVILY_API_KEY"],
    async search(query, opts) {
        const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
            },
            body: JSON.stringify({
                query,
                max_results: Math.min(opts.count ?? 5, 20),
                search_depth: opts.deep ? "advanced" : "basic",
                ...(opts.site ? { include_domains: [opts.site] } : {}),
            }),
        })

        if (!res.ok) throw new Error(`tavily ${res.status}: ${await res.text()}`)

        const data = await res.json() as {
            query: string
            results?: Array<{ title: string; url: string; content: string }>
        }

        return {
            query: data.query,
            provider: "tavily",
            items: (data.results ?? []).map(item => ({
                title: item.title,
                url: item.url,
                snippet: item.content,
            })),
        }
    },
}

const brave: Provider = {
    name: "brave",
    env: ["BRAVE_API_KEY"],
    async search(query, opts) {
        // site: is expressed in the query string — Brave has no domain filter.
        const q = opts.site ? `${query} site:${opts.site}` : query

        const url = new URL("https://api.search.brave.com/res/v1/web/search")
        url.searchParams.set("q", q)
        url.searchParams.set("count", String(Math.min(opts.count ?? 5, 20)))
        url.searchParams.set("safesearch", opts.safe === false ? "off" : "moderate")

        const res = await fetch(url, {
            headers: {
                Accept: "application/json",
                "X-Subscription-Token": process.env.BRAVE_API_KEY!,
            },
        })

        if (!res.ok) throw new Error(`brave ${res.status}: ${await res.text()}`)

        const data = await res.json() as {
            web?: { results?: Array<{ title: string; url: string; description: string }> }
        }

        return {
            query: q,
            provider: "brave",
            items: (data.web?.results ?? []).map(item => ({
                title: item.title,
                url: item.url,
                snippet: item.description,
            })),
        }
    },
}

const google: Provider = {
    name: "google",
    // Two, and both required: a key without a CSE id addresses no search
    // engine, so a half-configured Google is not a usable provider.
    env: ["GOOGLE_API_KEY", "GOOGLE_CSE_ID"],
    async search(query, opts) {
        const q = opts.site ? `${query} site:${opts.site}` : query

        const url = new URL("https://www.googleapis.com/customsearch/v1")
        url.searchParams.set("key", process.env.GOOGLE_API_KEY!)
        url.searchParams.set("cx", process.env.GOOGLE_CSE_ID!)
        url.searchParams.set("q", q)
        // 10 is the API's hard ceiling, not a choice.
        url.searchParams.set("num", String(Math.min(opts.count ?? 5, 10)))
        url.searchParams.set("safe", opts.safe === false ? "off" : "active")

        const res = await fetch(url)
        if (!res.ok) throw new Error(`google ${res.status}: ${await res.text()}`)

        const data = await res.json() as {
            queries?: { request?: Array<{ searchTerms?: string }> }
            items?: Array<{ title: string; link: string; snippet: string }>
        }

        return {
            query: data.queries?.request?.[0]?.searchTerms ?? q,
            provider: "google",
            items: (data.items ?? []).map(item => ({
                title: item.title,
                url: item.link,
                snippet: item.snippet,
            })),
        }
    },
}

export const PROVIDERS: readonly Provider[] = [tavily, brave, google]

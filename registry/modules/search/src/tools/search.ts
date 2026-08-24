import { PROVIDERS, configured, type Provider, type SearchOptions, type SearchResponse } from "../providers.js"

export type { SearchOptions, SearchResponse, SearchResult } from "../providers.js"

/**
 * Web search, over whichever provider this agent has a key for.
 *
 * ── One tool, many providers ────────────────────────────────────────────────
 *
 * An agent wants to know things. Which search API answers is an accident of
 * which key the user happened to set, and making the agent choose turns every
 * prompt into a branch — "use tavily, or google if that fails, or say you
 * cannot search". So there is one `search.web()`, and the provider is an
 * implementation detail reported in the response rather than a decision the
 * caller makes.
 *
 * ── Falling through, and what counts as failure ─────────────────────────────
 *
 * Providers are tried in order (see PROVIDERS). One is SKIPPED when its keys
 * are absent — that is not an error, it is a provider this agent does not have.
 * One that is configured and then fails IS an error, but not a terminal one:
 * a rate limit or an outage on the first provider is exactly what a second key
 * exists for, so the cascade continues and the failure is reported only if
 * nothing succeeds.
 *
 * That distinction is the whole design. Treating "no key" as a failure would
 * make an agent with one key look broken; treating "request failed" as a skip
 * would hide a misconfigured key behind a working fallback forever.
 */
export const search = {
    /**
     * Search the web.
     *
     * ```ts
     * const { items } = await search.web("bun test runner")
     * const { items } = await search.web("axon", { site: "github.com", count: 3 })
     * ```
     */
    async web(query: string, opts: SearchOptions & {
        /** Use only this provider. Throws if it is not configured. */
        only?: string
    } = {}): Promise<SearchResponse> {
        const { only, ...options } = opts

        const candidates: readonly Provider[] = only
            ? PROVIDERS.filter(provider => provider.name === only)
            : PROVIDERS

        if (only && candidates.length === 0) {
            throw new Error(
                `search: no provider named "${only}" — have ${PROVIDERS.map(p => p.name).join(", ")}`,
            )
        }

        const usable = candidates.filter(configured)

        if (usable.length === 0) {
            // Names the keys rather than saying "not configured", because the
            // fix is setting one of them and the user should not have to go
            // find out which.
            throw new Error(
                `search: no provider is configured — set one of ${
                    candidates.map(p => p.env.join(" + ")).join(", ")
                } in this agent's .env`,
            )
        }

        const failures: string[] = []

        for (const provider of usable) {
            try {
                return await provider.search(query, options)
            } catch (cause) {
                // Held, not thrown: the next provider is what a second key is
                // for. Reported below only if every one of them fails.
                failures.push(`${provider.name}: ${cause instanceof Error ? cause.message : String(cause)}`)
            }
        }

        throw new Error(`search: every configured provider failed —\n  ${failures.join("\n  ")}`)
    },

    /**
     * Which providers this agent can actually use, in the order they are tried.
     *
     * For answering "can I search?" without spending a request, and for telling
     * the user what to set when the answer is no.
     */
    providers(): Array<{ name: string; configured: boolean; env: string[] }> {
        return PROVIDERS.map(provider => ({
            name: provider.name,
            configured: configured(provider),
            env: [...provider.env],
        }))
    },
}

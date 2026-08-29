import { afterAll, describe, expect, test } from "bun:test"
import { Artifacts } from "../../src/registry/artifacts/artifacts"
import { Http } from "../../src/platform/http"

/**
 * `--sort` and `--limit` are only honest if they run over the COMPLETE result
 * set. The backend pages at 20 and offers no `?sort=`, so a client that sorted
 * one page would report "the most-installed module in the registry" after
 * looking at twenty arbitrary rows.
 *
 * These tests pin that with a paged fixture whose most-installed row is
 * deliberately on the LAST page — the one a single-page client never sees.
 */

const PAGE_SIZE = 20
const TOTAL = 45

/** Row `i`, with installs ASCENDING so the winner is on the final page. */
function row(index: number) {
    return {
        artifactId: `id-${index}`,
        kind: "module",
        name: `@axon/pkg-${String(index).padStart(3, "0")}`,
        description: null,
        private: false,
        latestVersion: "1.0.0",
        starsCount: index,
        installsCount: index * 10,
        ownerUsername: "axon",
        orgSlug: null,
        createdAt: "2026-01-01T00:00:00.000Z",
    }
}

let pagesServed: number[] = []

const registry = Bun.serve({
    port: 0,
    fetch(request) {
        const url = new URL(request.url)
        const page = Number(url.searchParams.get("page") ?? "1")
        pagesServed.push(page)

        const start = (page - 1) * PAGE_SIZE
        const artifacts = Array.from(
            { length: Math.max(0, Math.min(PAGE_SIZE, TOTAL - start)) },
            (_, i) => row(start + i),
        )
        return Response.json({ total: TOTAL, page, pageSize: PAGE_SIZE, artifacts })
    },
})

function artifacts() {
    pagesServed = []
    return Artifacts({
        http: Http({ baseUrl: registry.url.origin.replace(/\/$/, ""), token: () => undefined }),
        runtime: "node",
    })
}

afterAll(() => registry.stop(true))

describe("search: pagination", () => {
    test("follows pagination to the end rather than returning one page", async () => {
        const results = await artifacts().search({})
        expect(results).toHaveLength(TOTAL)
        expect(pagesServed).toEqual([1, 2, 3])
    })

    test("sorts across EVERY page, not just the first", async () => {
        // The most-installed artifact is the last row of the last page. A
        // client that sorted page one would name pkg-019 instead.
        const results = await artifacts().search({ sort: "installs", limit: 1 })
        expect(results[0]?.name).toBe(`@axon/pkg-${String(TOTAL - 1).padStart(3, "0")}`)
    })

    test("a limit does not stop paging early — it takes the top of the whole set", async () => {
        const results = await artifacts().search({ sort: "stars", limit: 3 })
        expect(results.map(item => item.name)).toEqual([
            "@axon/pkg-044",
            "@axon/pkg-043",
            "@axon/pkg-042",
        ])
        // All three pages were still fetched: the limit is applied to the
        // result, never used to cut the query short.
        expect(pagesServed).toEqual([1, 2, 3])
    })

    test("scope filtering applies across every page", async () => {
        const results = await artifacts().search({ scope: "@axon" })
        expect(results).toHaveLength(TOTAL)

        const none = await artifacts().search({ scope: "@nobody" })
        expect(none).toHaveLength(0)
    })
})

describe("search: query and kind reach the server", () => {
    test("query and kind are sent as parameters, scope and sort are not", async () => {
        const seen: URL[] = []
        const spy = Bun.serve({
            port: 0,
            fetch(request) {
                seen.push(new URL(request.url))
                return Response.json({ total: 0, page: 1, pageSize: PAGE_SIZE, artifacts: [] })
            },
        })

        const client = Artifacts({
            http: Http({ baseUrl: spy.url.origin.replace(/\/$/, ""), token: () => undefined }),
            runtime: "node",
        })
        await client.search({ query: "obsidian", kind: ["module", "prompt"], scope: "@axon", sort: "stars" })

        const params = seen[0]!.searchParams
        expect(params.get("q")).toBe("obsidian")
        expect(params.get("kind")).toBe("module,prompt")
        // Applied client-side — sending them would imply a server contract
        // that does not exist.
        expect(params.get("scope")).toBeNull()
        expect(params.get("sort")).toBeNull()

        spy.stop(true)
    })
})

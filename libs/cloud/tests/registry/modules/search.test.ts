import { AxonCloud } from "../../../src"
import { TEST_USER, scopedName } from "../../setup/user"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()

describe("registry.modules.search", () => {
    it("works with no key at all — the public catalog requires no auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.registry.artifacts.of("module").search()).resolves.toBeDefined()
    })

    it("returns an array of module records with the expected shape", async () => {
        const cloud = anonymousCloud()

        const results = await cloud.registry.artifacts.of("module").search()

        expect(Array.isArray(results)).toBe(true)
        if (results.length > 0) {
            const first = results[0]
            expect(typeof first.artifactId).toBe("string")
            expect(typeof first.name).toBe("string")
        }
    })

    it("a query filters results to matching names", async () => {
        const cloud = anonymousCloud()

        const results = await cloud.registry.artifacts.of("module").search({ query: "zzz-definitely-not-a-real-module-zzz" })

        expect(results).toEqual([])
    })

    it("paginates without throwing on an out-of-range page", async () => {
        const cloud = anonymousCloud()

        const result = await cloud.registry.artifacts.of("module").searchPage({ page: 9999 })

        expect(result.items).toEqual([])
    })

    it("search() follows pagination past the first page", async () => {
        const cloud = anonymousCloud()

        // A kind with more artifacts than one page: search() must return all
        // of them, while a single page stops at pageSize. This is the gap
        // that let the web catalogue show 20 of 37 prompts.
        const [all, first] = await Promise.all([
            cloud.registry.artifacts.of("prompt").search(),
            cloud.registry.artifacts.of("prompt").searchPage(),
        ])

        expect(all.length).toBe(first.total)
        if (first.total > first.pageSize) {
            expect(all.length).toBeGreaterThan(first.items.length)
        }
    })

    it("a freshly created (private-by-default) module does not appear in public search", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-module-search-private")
        await owner.registry.artifacts.of("module").create({ name })

        const anonymous = anonymousCloud()
        const results = await anonymous.registry.artifacts.of("module").search({ query: name })

        expect(results).toEqual([])
    })
})

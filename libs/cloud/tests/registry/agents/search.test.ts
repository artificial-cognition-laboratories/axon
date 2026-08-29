import { AxonCloud } from "../../../src"
import { TEST_USER, scopedName } from "../../setup/user"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()

describe("registry.agents.search", () => {
    it("works with no key at all — the public catalog requires no auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.registry.artifacts.of("agent").search()).resolves.toBeDefined()
    })

    it("returns an array of agent records with the expected shape", async () => {
        const cloud = anonymousCloud()

        const results = await cloud.registry.artifacts.of("agent").search()

        expect(Array.isArray(results)).toBe(true)
        if (results.length > 0) {
            const first = results[0]
            expect(typeof first.artifactId).toBe("string")
            expect(typeof first.name).toBe("string")
        }
    })

    it("a query filters results to matching names", async () => {
        const cloud = anonymousCloud()

        const results = await cloud.registry.artifacts.of("agent").search({ query: "zzz-definitely-not-a-real-agent-name-zzz" })

        expect(results).toEqual([])
    })

    it("does not require a real key to succeed — an invalid key still returns public results, not an error", async () => {
        const cloud = AxonCloud({ baseUrl, key: "axon_totally_not_a_real_key" })

        await expect(cloud.registry.artifacts.of("agent").search()).resolves.toBeDefined()
    })

    it("paginates without throwing on an out-of-range page", async () => {
        const cloud = anonymousCloud()

        const result = await cloud.registry.artifacts.of("agent").searchPage({ page: 9999 })

        expect(result.items).toEqual([])
    })

    it("a freshly created (private-by-default) agent does not appear in public search", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-search-private")
        await owner.registry.artifacts.of("agent").create({ name })

        const anonymous = anonymousCloud()
        const results = await anonymous.registry.artifacts.of("agent").search({ query: name })

        expect(results).toEqual([])
    })
})

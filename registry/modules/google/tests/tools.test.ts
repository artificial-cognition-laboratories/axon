import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { search } from "../src/tools/google.ts"

process.env.GOOGLE_API_KEY = "test-api-key"
process.env.GOOGLE_CSE_ID = "test-cse-id"

const mockResponse = {
    searchInformation: { totalResults: "42300" },
    queries: { request: [{ searchTerms: "bun javascript runtime" }] },
    items: [
        {
            title: "Bun — A fast all-in-one JavaScript runtime",
            link: "https://bun.sh",
            snippet: "Bun is an incredibly fast JavaScript runtime, bundler, test runner, and package manager.",
        },
        {
            title: "Bun on GitHub",
            link: "https://github.com/oven-sh/bun",
            snippet: "Incredibly fast JavaScript runtime, bundler, transpiler and package manager.",
        },
    ],
}

describe("google.search()", () => {
    let fetchSpy: ReturnType<typeof spyOn>

    beforeEach(() => {
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        )
    })

    afterEach(() => {
        fetchSpy.mockRestore()
    })

    it("returns structured results", async () => {
        const results = await search("bun javascript runtime")

        expect(results.query).toBe("bun javascript runtime")
        expect(results.total).toBe(42300)
        expect(results.items).toHaveLength(2)
    })

    it("returns correct item shape", async () => {
        const results = await search("bun javascript runtime")
        const first = results.items[0]!

        expect(first.title).toBe("Bun — A fast all-in-one JavaScript runtime")
        expect(first.url).toBe("https://bun.sh")
        expect(first.snippet).toContain("JavaScript runtime")
    })

    it("appends site: to query when site option is set", async () => {
        await search("TypeScript decorators", { site: "github.com" })

        const url = new URL((fetchSpy.mock.calls[0] as [URL])[0].toString())
        expect(url.searchParams.get("q")).toBe("TypeScript decorators site:github.com")
    })

    it("caps count at 10", async () => {
        await search("test", { count: 99 })

        const url = new URL((fetchSpy.mock.calls[0] as [URL])[0].toString())
        expect(url.searchParams.get("num")).toBe("10")
    })

    it("defaults count to 5", async () => {
        await search("test")

        const url = new URL((fetchSpy.mock.calls[0] as [URL])[0].toString())
        expect(url.searchParams.get("num")).toBe("5")
    })

    it("throws on non-200 API response", async () => {
        fetchSpy.mockResolvedValue(
            new Response(JSON.stringify({ error: { message: "API key invalid" } }), { status: 403 })
        )

        await expect(search("test")).rejects.toThrow("Google Search API error 403")
    })

    it("returns empty items when API returns no results", async () => {
        fetchSpy.mockResolvedValue(
            new Response(
                JSON.stringify({
                    searchInformation: { totalResults: "0" },
                    queries: { request: [{ searchTerms: "xyzzy nobody knows this" }] },
                }),
                { status: 200 }
            )
        )

        const results = await search("xyzzy nobody knows this")
        expect(results.items).toEqual([])
        expect(results.total).toBe(0)
    })
})

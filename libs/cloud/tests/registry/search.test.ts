import { describe, expect, test } from "bun:test"
import {
    SORT_ORDERS,
    parseKinds,
    parseLimit,
    parseSort,
    refine,
} from "../../src/registry/artifacts/search"
import type { ArtifactRecord } from "../../src/registry/artifacts/types"

/** A catalogue row with only the fields search actually orders and filters on. */
function artifact(input: Partial<ArtifactRecord> & { name: string }): ArtifactRecord {
    return {
        artifactId: input.name,
        kind: "module",
        description: null,
        readme: null,
        private: false,
        latestVersion: "1.0.0",
        starsCount: 0,
        installsCount: 0,
        ownerUsername: null,
        orgSlug: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        deprecatedAt: null,
        deprecationMessage: null,
        ...input,
    }
}

const CATALOGUE: ArtifactRecord[] = [
    artifact({ name: "@axon/zero", starsCount: 5, installsCount: 100, createdAt: "2026-01-01T00:00:00.000Z" }),
    artifact({ name: "@axon/docs", starsCount: 1, installsCount: 900, createdAt: "2026-03-01T00:00:00.000Z" }),
    artifact({ name: "@cody/obsidian", starsCount: 9, installsCount: 10, createdAt: "2026-02-01T00:00:00.000Z" }),
    artifact({ name: "@cody/arxiv", starsCount: 9, installsCount: 10, createdAt: "2026-05-01T00:00:00.000Z" }),
]

const names = (items: ArtifactRecord[]) => items.map(item => item.name)

describe("search: sorting", () => {
    test("relevance leaves the server's ranking untouched", () => {
        // The server ranked these. Re-sorting would discard exactly the signal
        // the ordering exists to carry.
        expect(names(refine(CATALOGUE, { sort: "relevance" }))).toEqual(names(CATALOGUE))
    })

    test("relevance is the default when no sort is given", () => {
        expect(names(refine(CATALOGUE, {}))).toEqual(names(CATALOGUE))
    })

    test("stars orders by star count, descending", () => {
        const sorted = refine(CATALOGUE, { sort: "stars" })
        expect(sorted.map(item => item.starsCount)).toEqual([9, 9, 5, 1])
    })

    test("installs orders by install count, descending", () => {
        expect(names(refine(CATALOGUE, { sort: "installs" }))).toEqual([
            "@axon/docs",
            "@axon/zero",
            "@cody/arxiv",
            "@cody/obsidian",
        ])
    })

    test("name orders alphabetically", () => {
        expect(names(refine(CATALOGUE, { sort: "name" }))).toEqual([
            "@axon/docs",
            "@axon/zero",
            "@cody/arxiv",
            "@cody/obsidian",
        ])
    })

    test("recent orders newest first", () => {
        expect(names(refine(CATALOGUE, { sort: "recent" }))).toEqual([
            "@cody/arxiv",
            "@axon/docs",
            "@cody/obsidian",
            "@axon/zero",
        ])
    })

    test("ties break by name, so two identical searches cannot disagree", () => {
        // obsidian and arxiv both have 9 stars. Without the tiebreak their
        // relative order would be whatever the input happened to be.
        const first = names(refine(CATALOGUE, { sort: "stars" }))
        const shuffled = names(refine([...CATALOGUE].reverse(), { sort: "stars" }))
        expect(first).toEqual(shuffled)
        expect(first.slice(0, 2)).toEqual(["@cody/arxiv", "@cody/obsidian"])
    })

    test("sorting does not mutate the caller's array", () => {
        const original = names(CATALOGUE)
        refine(CATALOGUE, { sort: "installs" })
        expect(names(CATALOGUE)).toEqual(original)
    })
})

describe("search: scope filtering", () => {
    test("narrows to one namespace", () => {
        expect(names(refine(CATALOGUE, { scope: "@axon" }))).toEqual(["@axon/zero", "@axon/docs"])
    })

    test("accepts a scope with or without the leading @", () => {
        expect(names(refine(CATALOGUE, { scope: "axon" }))).toEqual(names(refine(CATALOGUE, { scope: "@axon" })))
    })

    test("accepts a trailing slash", () => {
        expect(names(refine(CATALOGUE, { scope: "@axon/" }))).toEqual(["@axon/zero", "@axon/docs"])
    })

    test("is case-insensitive", () => {
        expect(names(refine(CATALOGUE, { scope: "@AXON" }))).toEqual(["@axon/zero", "@axon/docs"])
    })

    test("matches the scope boundary, not a bare prefix", () => {
        // "@axo" must not match "@axon/..." — without the trailing slash in the
        // prefix, a partial scope would silently widen the filter.
        expect(refine(CATALOGUE, { scope: "@axo" })).toEqual([])
    })

    test("an unmatched scope returns nothing rather than everything", () => {
        expect(refine(CATALOGUE, { scope: "@nobody" })).toEqual([])
    })
})

describe("search: limit", () => {
    test("caps the number of results", () => {
        expect(refine(CATALOGUE, { limit: 2 })).toHaveLength(2)
    })

    test("a limit larger than the result set returns everything", () => {
        expect(refine(CATALOGUE, { limit: 99 })).toHaveLength(4)
    })

    test("APPLIES AFTER SORTING — the top N of everything, not N arbitrary rows sorted", () => {
        // The whole reason refine() orders its steps. @axon/docs is last in
        // catalogue order but first by installs; limiting before sorting would
        // drop it and report @axon/zero as the most-installed artifact.
        expect(names(refine(CATALOGUE, { sort: "installs", limit: 1 }))).toEqual(["@axon/docs"])
    })

    test("APPLIES AFTER SCOPE — the top N within the scope", () => {
        expect(names(refine(CATALOGUE, { scope: "@cody", sort: "stars", limit: 1 }))).toEqual(["@cody/arxiv"])
    })
})

describe("search: input parsing", () => {
    test("parses a comma-separated kind list", () => {
        expect(parseKinds("module,cognet")).toEqual(["module", "cognet"])
    })

    test("tolerates whitespace around kinds", () => {
        expect(parseKinds(" module , cognet ")).toEqual(["module", "cognet"])
    })

    test("rejects an unknown kind, naming the valid ones", () => {
        expect(() => parseKinds("modul")).toThrow(/unknown kind: modul/)
        expect(() => parseKinds("modul")).toThrow(/module/)
    })

    test("rejects an unknown sort, naming the valid ones", () => {
        expect(() => parseSort("populariy")).toThrow(/unknown sort/)
        for (const order of SORT_ORDERS) expect(parseSort(order)).toBe(order)
    })

    test("rejects a non-positive or non-numeric limit rather than clamping it", () => {
        // Silently substituting a default would answer a question nobody asked
        // while looking like it worked.
        expect(() => parseLimit("0")).toThrow(/invalid limit/)
        expect(() => parseLimit("-3")).toThrow(/invalid limit/)
        expect(() => parseLimit("abc")).toThrow(/invalid limit/)
        expect(() => parseLimit("1.5")).toThrow(/invalid limit/)
        expect(parseLimit("20")).toBe(20)
    })
})

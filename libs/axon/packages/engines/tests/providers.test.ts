import { describe, expect, test } from "bun:test"
import { Axon, Codex, HuggingFace, Ollama, providerPool } from "../src/providers"

describe("provider factories", () => {
    test("declare a source without connecting to it", () => {
        expect(Axon()).toEqual({ provider: "axon" })
        expect(Ollama()).toEqual({ provider: "ollama" })
    })

    test("carry a direct key for the self-hosted case", () => {
        expect(HuggingFace({ key: "hf_abc" })).toEqual({ provider: "huggingface", key: "hf_abc" })
    })

    test("omit absent options rather than emitting undefined", () => {
        expect(Object.keys(Codex({ slots: 2 }))).toEqual(["provider", "slots"])
    })
})

describe("providerPool", () => {
    test("profile providers come first", () => {
        const pool = providerPool([Axon()], [Ollama()])

        expect(pool.map(p => p.provider)).toEqual(["axon", "ollama"])
    })

    test("an agent adds a source the user did not declare", () => {
        const pool = providerPool([Axon()], [HuggingFace()])

        expect(pool).toHaveLength(2)
        expect(pool.some(p => p.provider === "huggingface")).toBe(true)
    })

    test("an agent cannot displace the user's own declaration", () => {
        const pool = providerPool([Axon({ slots: 2 })], [Axon({ slots: 64 })])

        expect(pool).toHaveLength(1)
        expect(pool[0]?.slots).toBe(2)
    })

    test("an empty profile still yields the agent's own sources", () => {
        expect(providerPool([], [Ollama()])).toHaveLength(1)
    })

    test("a profile that never declared providers gets the managed route", () => {
        // THE BUG THIS PINS: every profile written before `providers:` existed
        // has no field, and answering "you have no inference" for those meant
        // every one of them refused to boot. Absent is "never asked", and the
        // answer is the route that needs no setup.
        expect(providerPool(undefined, undefined)).toEqual([{ provider: "axon" }])
    })

    test("a deliberately empty profile is honoured, not defaulted", () => {
        // `[]` is a real answer from a user who cleared their providers. It
        // fails the boot loudly, which is correct and only reachable on
        // purpose — collapsing it into the default would silently restore
        // something they removed.
        expect(providerPool([], undefined)).toEqual([])
    })

    test("an agent's own providers still apply to an unconfigured profile", () => {
        expect(providerPool(undefined, [Ollama()]).map(p => p.provider)).toEqual(["axon", "ollama"])
    })
})

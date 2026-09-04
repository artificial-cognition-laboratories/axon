import { describe, expect, test } from "bun:test"
import { Axon, Codex, HuggingFace, Local, Mock, Ollama, providerPool } from "../src/providers"

describe("provider factories", () => {
    test("declare a source without connecting to it", () => {
        expect(Axon()).toEqual({ provider: "axon" })
        expect(Local()).toEqual({ provider: "local" })
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
    /**
     * `mock` is in every pool without being declared. `axon` is not.
     *
     * The distinction is the whole design. Mock needs no credential, reaches
     * no network and costs nothing, so there is no statement a user could make
     * that "no mock" is the sensible reading of.
     *
     * Axon is BILLED. Making it implicit removed the only way to say *do not
     * use my Axon account for this agent* — `providers: [Ollama()]` has to
     * keep meaning Ollama and nothing else, and a cognet asking for a model
     * would otherwise resolve against an account the user had deliberately
     * left out. So axon is a DEFAULT for a profile that never declared
     * anything, and declaring anything at all is the opt-out.
     */
    const implicit = ["mock", "local"]

    test("profile providers come first, implicit ones last", () => {
        // Order is preference order among candidates that all satisfy a role,
        // so something nobody asked for must not outrank something somebody
        // did.
        const pool = providerPool([Codex()], [Ollama()])

        expect(pool.map(p => p.provider)).toEqual(["codex", "ollama", ...implicit])
    })

    test("declaring providers REMOVES the default axon", () => {
        // The opt-out, and the reason axon is not implicit. A user who routes
        // inference through Ollama has said so, and silently billing their
        // Axon account anyway is the failure this shape exists to prevent.
        expect(providerPool([Ollama()], undefined).map(p => p.provider)).not.toContain("axon")
    })

    test("an agent adds a source the user did not declare", () => {
        const pool = providerPool([Codex()], [HuggingFace()])

        expect(pool.map(p => p.provider)).toEqual(["codex", "huggingface", ...implicit])
    })

    test("an agent cannot displace the user's own declaration", () => {
        const pool = providerPool([Axon({ slots: 2 })], [Axon({ slots: 64 })])

        expect(pool.filter(p => p.provider === "axon")).toHaveLength(1)
        expect(pool.find(p => p.provider === "axon")?.slots).toBe(2)
    })

    test("a declared axon OVERRIDES the implicit one rather than duplicating it", () => {
        // The point of appending the implicit entries last: a user who set a
        // ceiling keeps it, and does not get a second unbounded axon beside it.
        const pool = providerPool([Axon({ slots: 2 })], undefined)

        expect(pool.filter(p => p.provider === "axon")).toHaveLength(1)
        expect(pool.find(p => p.provider === "axon")?.slots).toBe(2)
    })

    test("a declared local OVERRIDES the implicit one", () => {
        const pool = providerPool([Local({ slots: 1 })], undefined)

        expect(pool.filter(p => p.provider === "local")).toHaveLength(1)
        expect(pool.find(p => p.provider === "local")?.slots).toBe(1)
    })

    test("a declared mock OVERRIDES the implicit one", () => {
        // Mock carries its SCRIPT on the entry, so a duplicate would mean the
        // agent's own scripted replies losing to an empty default.
        const scripted = { ...Mock(), script: { hello: "hi" } } as never
        const pool = providerPool(undefined, [scripted])

        expect(pool.filter(p => p.provider === "mock")).toHaveLength(1)
        expect((pool.find(p => p.provider === "mock") as { script?: unknown }).script).toBeDefined()
    })

    test("an empty profile still yields the agent's own sources", () => {
        expect(providerPool([], [Ollama()]).map(p => p.provider)).toEqual(["ollama", ...implicit])
    })

    test("a profile that never declared providers gets the managed route", () => {
        // THE BUG THIS PINS: every profile written before `providers:` existed
        // has no field, and answering "you have no inference" for those meant
        // every one of them refused to boot. Absent is "never asked", and the
        // answer is the route that needs no setup.
        expect(providerPool(undefined, undefined).map(p => p.provider)).toEqual(["axon", ...implicit])
    })

    test("an empty array removes axon but still boots on mock", () => {
        // `[]` is a real answer: the user cleared their providers, so the
        // billed route is gone. The agent still starts, because mock can fill
        // an ordinary text role — which is right for a cognet that needs no
        // LLM at all. A control loop declares no engine roles, and refusing to
        // start it because no inference was declared assumes a model this
        // system does not require.
        expect(providerPool([], undefined).map(p => p.provider)).toEqual(implicit)
    })

    test("an agent's own providers still apply to an unconfigured profile", () => {
        // The PROFILE was never asked, so it keeps the default; the agent adds
        // to it. An agent can never remove what the user has.
        expect(providerPool(undefined, [Ollama()]).map(p => p.provider)).toEqual(["axon", "ollama", ...implicit])
    })

    test("never lists a provider twice", () => {
        const pool = providerPool([Axon(), Codex()], [Axon(), Ollama(), Mock()])

        expect(new Set(pool.map(p => p.provider)).size).toBe(pool.length)
    })
})

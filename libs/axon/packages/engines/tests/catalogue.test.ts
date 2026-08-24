import { describe, expect, test } from "bun:test"
import type { AxonEngineDriver, EngineCapability, EngineRequirements } from "@arcforge/types"
import { Engines, fromModalities, fromOllamaCapabilities, fromPipelineTag, gather } from "../src/catalogue"
import type { AxonProvider } from "../src/catalogue"

const driver: AxonEngineDriver = {
    async *stream() {},
}

function capability(overrides: Partial<EngineCapability> & Pick<EngineCapability, "id" | "provider">): EngineCapability {
    return {
        name: overrides.id,
        type: "generate",
        in: ["text"],
        out: ["text"],
        context: 128_000,
        structured: true,
        ...overrides,
    }
}

function provider(name: string, capabilities: EngineCapability[], fail?: string): AxonProvider {
    return {
        name,
        async catalogue() {
            if (fail) throw new Error(fail)
            return capabilities
        },
        async resolve() {
            return null
        },
        create() {
            return driver
        },
    }
}

describe("modality classification", () => {
    test("a mapped pipeline tag yields a shape", () => {
        expect(fromPipelineTag("automatic-speech-recognition")).toEqual({
            type: "transform",
            in: ["audio"],
            out: ["text"],
        })
    })

    test("voice activity detection is a stateful stream", () => {
        expect(fromPipelineTag("voice-activity-detection")?.type).toBe("stream")
    })

    test("an unmapped tag is refused rather than guessed", () => {
        expect(fromPipelineTag("tabular-regression")).toBeNull()
        expect(fromPipelineTag(undefined)).toBeNull()
    })

    test("ollama vision widens the input modalities", () => {
        expect(fromOllamaCapabilities(["chat"]).in).toEqual(["text"])
        expect(fromOllamaCapabilities(["chat", "vision"]).in).toEqual(["text", "image"])
    })

    test("published modality arrays pass through", () => {
        expect(fromModalities(["text", "image"], ["text"])).toEqual({
            type: "generate",
            in: ["text", "image"],
            out: ["text"],
        })
    })

    test("an unknown upstream modality narrows rather than removes the model", () => {
        expect(fromModalities(["text", "hologram"], undefined).in).toEqual(["text"])
    })
})

describe("gather", () => {
    test("merges every provider's capabilities", async () => {
        const result = await gather([
            provider("axon", [capability({ id: "a", provider: "axon" })]),
            provider("ollama", [capability({ id: "b", provider: "ollama", local: true })]),
        ])

        expect(result.capabilities).toHaveLength(2)
        expect(result.failures).toHaveLength(0)
    })

    test("an unreachable provider is a visible failure, never a shorter list", async () => {
        const result = await gather([
            provider("axon", [capability({ id: "a", provider: "axon" })]),
            provider("ollama", [], "daemon not running"),
        ])

        expect(result.capabilities).toHaveLength(1)
        expect(result.failures).toEqual([{ provider: "ollama", message: "daemon not running" }])
    })

    test("one failure does not prevent the others answering", async () => {
        const result = await gather([
            provider("a", [], "down"),
            provider("b", [capability({ id: "b", provider: "b" })]),
        ])

        expect(result.capabilities).toHaveLength(1)
        expect(result.failures).toHaveLength(1)
    })
})

describe("Engines", () => {
    const cloud = capability({ id: "cloud/big", provider: "axon", context: 200_000 })
    const local = capability({ id: "local/small", provider: "ollama", context: 32_000, local: true })

    const providers = new Map<string, AxonProvider>([
        ["axon", provider("axon", [cloud])],
        ["ollama", provider("ollama", [local])],
    ])

    test("binds declared roles at construction", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 100_000 },
        }

        const engines = Engines({ requirements, capabilities: [cloud, local], providers })

        expect(engines.has("main")).toBe(true)
        expect(engines.get("main").binding.capability.id).toBe("cloud/big")
    })

    test("an unfilled optional role answers has() with false", () => {
        const requirements: EngineRequirements = {
            percept: { type: "generate", in: "text", out: "text", context: 999_999, optional: true },
        }

        const engines = Engines({ requirements, capabilities: [cloud], providers })

        expect(engines.has("percept")).toBe(false)
        expect(engines.resolution.missing).toHaveLength(0)
    })

    test("calling an unbound role throws rather than returning a null driver", () => {
        const engines = Engines({ requirements: {}, capabilities: [], providers })

        expect(() => engines.get("main")).toThrow(/ENGINE_ROLE_UNBOUND/)
    })

    test("asking about a role that was never declared is a question, not an error", () => {
        const engines = Engines({ requirements: {}, capabilities: [], providers })

        expect(engines.has("anything")).toBe(false)
    })

    test("rebind points a role at a different model", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 32_000 },
        }

        const engines = Engines({ requirements, capabilities: [cloud, local], providers })
        const before = engines.get("main").binding.capability.id

        engines.rebind("main", cloud)

        expect(engines.get("main").binding.capability.id).toBe("cloud/big")
        expect(before).toBe("local/small")
    })

    /**
     * `select()` — the model picker's one entry point.
     *
     * ── What these defend ───────────────────────────────────────────────────
     *
     * `rebind()` takes a capability; a picker has a STRING. Nothing bridged the
     * two, so the TUI's model picker could not reach `rebind()` at all: it
     * wrote the choice to the agent's config and waited for a hot reload to
     * apply it. A reload deliberately does not re-resolve inference, so the
     * live binding never moved and the pick only took effect after a full
     * reboot — the user picked a model, the picker showed it as current, and
     * replies kept coming from the previous one.
     */
    describe("select — a picked model string, applied to the live binding", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 32_000, primary: true },
        }

        test("repoints the primary role at the picked model", () => {
            const engines = Engines({ requirements, capabilities: [cloud, local], providers })

            const bound = engines.select("cloud/big")

            expect(bound?.id).toBe("cloud/big")
            expect(engines.get("main").binding.capability.id).toBe("cloud/big")
        })

        test("honours a provider-qualified pin", () => {
            // `"provider:model"` is how the picker names a route explicitly,
            // and how a model reachable through two providers is disambiguated.
            const engines = Engines({ requirements, capabilities: [cloud, local], providers })

            expect(engines.select("axon:cloud/big")?.id).toBe("cloud/big")
            expect(engines.get("main").binding.capability.id).toBe("cloud/big")
        })

        test("a pin naming the wrong route for a real model is not honoured", () => {
            // `cloud/big` exists, but on `axon` — not on `ollama`. Matching the
            // model alone would silently run it through a route the user did
            // not ask for, which is the failure a qualified pin exists to
            // prevent.
            const engines = Engines({ requirements, capabilities: [cloud, local], providers })
            const before = engines.get("main").binding.capability.id

            expect(engines.select("ollama:cloud/big")).toBeNull()
            expect(engines.get("main").binding.capability.id).toBe(before)
        })

        test("returns null for a model no declared provider supplies", () => {
            // A pin PREFERS and never requires, so a model the pool cannot
            // supply is a choice that could not be honoured — not an error.
            // The binding must be left exactly as it was.
            const engines = Engines({ requirements, capabilities: [cloud, local], providers })
            const before = engines.get("main").binding.capability.id

            expect(engines.select("nothing/here")).toBeNull()
            expect(engines.get("main").binding.capability.id).toBe(before)
        })

        test("picking the model already bound is a no-op that still reports it", () => {
            // Rebuilding the driver would drop a warm connection for no change,
            // but the caller still needs to know the pick was honoured.
            const engines = Engines({ requirements, capabilities: [cloud, local], providers })
            const current = engines.get("main")

            const bound = engines.select(current.binding.capability.id)

            expect(bound?.id).toBe(current.binding.capability.id)
            expect(engines.get("main").driver).toBe(current.driver)
        })

        test("names the role a picker edits", () => {
            const engines = Engines({ requirements, capabilities: [cloud, local], providers })
            expect(engines.primary).toBe("main")
        })

        test("a cognet with no primary role has nothing to pick", () => {
            // A pure control loop declares no generate role. Inventing one
            // would put a dead entry in the picker.
            const engines = Engines({ requirements: {}, capabilities: [], providers })

            expect(engines.primary).toBeNull()
            expect(engines.select("cloud/big")).toBeNull()
        })
    })

    test("alternates offer the other candidates for a role", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 32_000 },
        }

        const engines = Engines({ requirements, capabilities: [cloud, local], providers })

        expect(engines.alternates("main").map(c => c.id)).toContain("cloud/big")
    })

    test("a capability from a provider outside the pool fails loudly", () => {
        const orphan = capability({ id: "ghost", provider: "nowhere" })
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text" },
        }

        expect(() => Engines({ requirements, capabilities: [orphan], providers })).toThrow(/ENGINE_PROVIDER_MISSING/)
    })
})

import { describe, expect, test } from "bun:test"
import type { EngineCapability, EngineRequirements } from "@arcforge/types"
import { parsePin, primaryRole, resolveEngines } from "../src/resolver"

const frontier: EngineCapability = {
    id: "anthropic/claude-sonnet-4-6",
    provider: "axon",
    name: "Claude Sonnet 4.6",
    type: "generate",
    in: ["text", "image"],
    out: ["text"],
    context: 200_000,
    structured: true,
}

const small: EngineCapability = {
    id: "gemma3:4b",
    provider: "ollama",
    name: "Gemma 3 4B",
    type: "generate",
    in: ["text", "image"],
    out: ["text"],
    context: 128_000,
    structured: true,
    local: true,
    slots: 2,
    bytes: 3_300_000_000,
}

const tiny: EngineCapability = {
    id: "gemma3:1b",
    provider: "ollama",
    name: "Gemma 3 1B",
    type: "generate",
    in: ["text"],
    out: ["text"],
    context: 32_000,
    structured: true,
    local: true,
    slots: 1,
}

const silero: EngineCapability = {
    id: "onnx-community/silero-vad",
    provider: "huggingface",
    name: "Silero VAD",
    type: "stream",
    in: ["audio"],
    out: ["score"],
    local: true,
}

const whisper: EngineCapability = {
    id: "openai/whisper-base",
    provider: "huggingface",
    name: "Whisper Base",
    type: "transform",
    in: ["audio"],
    out: ["text"],
    local: true,
}

describe("resolveEngines", () => {
    test("binds a role to a capability that satisfies it", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 100_000 },
        }

        const result = resolveEngines(requirements, [frontier])

        expect(result.bound).toHaveLength(1)
        expect(result.bound[0]?.role).toBe("main")
        expect(result.bound[0]?.capability.id).toBe("anthropic/claude-sonnet-4-6")
        expect(result.missing).toHaveLength(0)
    })

    test("a required role with no candidate is missing, with a readable reason", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 100_000 },
        }

        const result = resolveEngines(requirements, [tiny])

        expect(result.bound).toHaveLength(0)
        expect(result.missing).toHaveLength(1)
        expect(result.missing[0]?.role).toBe("main")
        expect(result.missing[0]?.reasons.join()).toContain("context 32000 < 100000")
    })

    test("an unfilled optional role is unmet but never missing", () => {
        const requirements: EngineRequirements = {
            percept: { type: "generate", in: "text", out: "text", context: 500_000, optional: true },
        }

        const result = resolveEngines(requirements, [frontier])

        expect(result.unmet).toHaveLength(1)
        expect(result.missing).toHaveLength(0)
    })

    test("one capability fills several roles", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 100_000 },
            compress: { type: "generate", in: "text", out: "text", context: 12_000 },
        }

        const result = resolveEngines(requirements, [frontier])

        expect(result.bound).toHaveLength(2)
        expect(result.bound.every(b => b.capability.id === frontier.id)).toBe(true)
    })

    test("a text-only model never fills a role that sends images", () => {
        const requirements: EngineRequirements = {
            vision: { type: "generate", in: ["text", "image"], out: "text" },
        }

        const result = resolveEngines(requirements, [tiny])

        expect(result.missing).toHaveLength(1)
        expect(result.missing[0]?.reasons.join()).toContain("cannot accept image")
    })

    test("type separates two models with the same modalities", () => {
        const requirements: EngineRequirements = {
            asr: { type: "transform", in: "audio", out: "text" },
        }

        const result = resolveEngines(requirements, [silero, whisper])

        expect(result.bound[0]?.capability.id).toBe("openai/whisper-base")
    })

    test("vad and asr are told apart by output modality alone", () => {
        const requirements: EngineRequirements = {
            vad: { type: "stream", in: "audio", out: "score" },
        }

        const result = resolveEngines(requirements, [silero, whisper])

        expect(result.bound).toHaveLength(1)
        expect(result.bound[0]?.capability.id).toBe("onnx-community/silero-vad")
    })

    test("unknown context does not exclude a candidate", () => {
        const unpriced: EngineCapability = { ...frontier, id: "codex/gpt-5", provider: "codex", context: undefined }
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 100_000 },
        }

        const result = resolveEngines(requirements, [unpriced])

        expect(result.bound).toHaveLength(1)
    })

    test("structured output is refused when unknown", () => {
        const unknown: EngineCapability = { ...frontier, structured: undefined }
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", structured: true },
        }

        const result = resolveEngines(requirements, [unknown])

        expect(result.missing[0]?.reasons.join()).toContain("no structured output")
    })

    test("local is preferred over hosted when both satisfy", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 100_000 },
        }

        const result = resolveEngines(requirements, [frontier, small])

        expect(result.bound[0]?.capability.id).toBe("gemma3:4b")
    })
})

describe("slots", () => {
    test("a role without parallel is strictly sequential", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text" },
        }

        const result = resolveEngines(requirements, [frontier])

        expect(result.bound[0]?.slots).toBe(1)
    })

    test("a parallel role on a hosted route gets unbounded concurrency", () => {
        const requirements: EngineRequirements = {
            percept: { type: "generate", in: "text", out: "text", parallel: true },
        }

        const result = resolveEngines(requirements, [frontier])

        expect(result.bound[0]?.slots).toBeGreaterThan(1)
    })

    test("a parallel role degrades to the binding's limit, never to zero", () => {
        const requirements: EngineRequirements = {
            percept: { type: "generate", in: "text", out: "text", parallel: true },
        }

        const result = resolveEngines(requirements, [tiny])

        expect(result.bound).toHaveLength(1)
        expect(result.bound[0]?.slots).toBe(1)
    })
})

describe("primaryRole", () => {
    test("an explicit flag wins", () => {
        const role = primaryRole({
            cortex: { type: "generate", in: "text", out: "text", primary: true },
            main: { type: "generate", in: "text", out: "text" },
        })

        expect(role).toBe("cortex")
    })

    test("falls back to a role named main", () => {
        const role = primaryRole({
            main: { type: "generate", in: "text", out: "text" },
            percept: { type: "generate", in: "text", out: "text" },
        })

        expect(role).toBe("main")
    })

    test("a cognet with no generate role has no primary", () => {
        const role = primaryRole({
            vad: { type: "stream", in: "audio", out: "score" },
        })

        expect(role).toBeNull()
    })
})

describe("the offline case", () => {
    test("a fully local pool resolves an agent with no network", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 100_000, structured: true },
            percept: { type: "generate", in: "text", out: "text", context: 12_000, parallel: true, optional: true },
            vad: { type: "stream", in: "audio", out: "score", optional: true },
        }

        const result = resolveEngines(requirements, [small, tiny, silero])

        expect(result.missing).toHaveLength(0)
        expect(result.bound).toHaveLength(3)
        expect(result.bound.every(b => b.capability.local === true)).toBe(true)
    })

    test("an empty pool leaves every required role missing and every optional one merely unmet", () => {
        const requirements: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text" },
            percept: { type: "generate", in: "text", out: "text", optional: true },
        }

        const result = resolveEngines(requirements, [])

        expect(result.missing).toHaveLength(1)
        expect(result.missing[0]?.role).toBe("main")
        expect(result.unmet).toHaveLength(2)
    })
})

describe("model pins", () => {
    const requirements: EngineRequirements = {
        main: { type: "generate", in: "text", out: "text", primary: true },
        percept: { type: "generate", in: "text", out: "text", optional: true },
    }

    const codex: EngineCapability = { ...frontier, id: "gpt-5.6-terra", provider: "codex" }
    const openrouter: EngineCapability = { ...frontier, id: "gpt-5.6-terra", provider: "openrouter" }

    test("a route pin binds that exact provider and model", () => {
        const result = resolveEngines(requirements, [frontier, codex, openrouter], { model: "codex:gpt-5.6-terra" })
        const main = result.bound.find(b => b.role === "main")

        expect(main?.capability.provider).toBe("codex")
        expect(main?.capability.id).toBe("gpt-5.6-terra")
    })

    test("a bare model pin lets ranking choose the route", () => {
        const result = resolveEngines(requirements, [frontier, openrouter], { model: "gpt-5.6-terra" })

        expect(result.bound.find(b => b.role === "main")?.capability.id).toBe("gpt-5.6-terra")
    })

    test("a pin nothing can supply falls back to ranking, never to a failure", () => {
        const result = resolveEngines(requirements, [frontier], { model: "codex:not-installed" })

        expect(result.missing).toHaveLength(0)
        expect(result.bound.find(b => b.role === "main")?.capability.id).toBe(frontier.id)
    })

    test("a pin never overrides the role's own constraints", () => {
        const strict: EngineRequirements = {
            main: { type: "generate", in: "text", out: "text", context: 150_000, primary: true },
        }
        // tiny satisfies the pin but not the context floor
        const result = resolveEngines(strict, [frontier, tiny], { model: "gemma3:1b" })

        expect(result.bound[0]?.capability.id).toBe(frontier.id)
    })

    test("a pin applies to the primary role only", () => {
        const result = resolveEngines(requirements, [frontier, codex], { model: "codex:gpt-5.6-terra" })
        const percept = result.bound.find(b => b.role === "percept")

        expect(percept?.capability.provider).not.toBe("codex")
    })

    test("no pin resolves exactly as before", () => {
        const withPin = resolveEngines(requirements, [frontier, codex], {})
        const without = resolveEngines(requirements, [frontier, codex])

        expect(withPin.bound.map(b => b.capability.id)).toEqual(without.bound.map(b => b.capability.id))
    })
})

describe("parsePin", () => {
    test("splits a route pin on the first colon only", () => {
        expect(parsePin("ollama:qwen3:8b")).toEqual({ provider: "ollama", model: "qwen3:8b" })
    })

    test("a bare model has no provider", () => {
        expect(parsePin("gpt-5.6-terra")).toEqual({ model: "gpt-5.6-terra" })
    })

    test("keeps slashes in a model id", () => {
        expect(parsePin("openrouter:anthropic/claude-sonnet-4-6"))
            .toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-4-6" })
    })

    test("nothing declared is no preference", () => {
        expect(parsePin(undefined)).toBeNull()
        expect(parsePin("   ")).toBeNull()
    })
})

describe("an unhonoured pin is reported, never swallowed", () => {
    const requirements: EngineRequirements = {
        main: { type: "generate", in: "text", out: "text", primary: true },
    }

    test("names the provider when the model exists on another route", () => {
        const result = resolveEngines(requirements, [frontier], {
            model: `codex:${frontier.id}`,
        })

        expect(result.bound).toHaveLength(1)
        expect(result.unhonoured?.pin).toBe(`codex:${frontier.id}`)
        expect(result.unhonoured?.reason).toContain("another route")
    })

    test("says so when nothing supplies the model at all", () => {
        const result = resolveEngines(requirements, [frontier], { model: "nonexistent-model" })

        expect(result.unhonoured?.reason).toContain("nonexistent-model")
    })

    test("a honoured pin reports nothing", () => {
        const result = resolveEngines(requirements, [frontier], { model: `axon:${frontier.id}` })

        expect(result.unhonoured).toBeUndefined()
    })

    test("no pin reports nothing", () => {
        expect(resolveEngines(requirements, [frontier]).unhonoured).toBeUndefined()
    })
})

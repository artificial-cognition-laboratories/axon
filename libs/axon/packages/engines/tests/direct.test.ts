import { describe, expect, test } from "bun:test"
import { AiSdk, DIRECT_PROVIDERS } from "../src/aisdk"
import { buildProvider } from "../src/providers"
import {
    Anthropic, Cerebras, DeepSeek, Google, Groq, Mistral, Moonshot, OpenAI, Perplexity, XAI, ZAI,
} from "../src/providers"
import type { EngineCloud } from "@arcforge/types"

const cloud = {} as EngineCloud

describe("direct providers", () => {
    test("every factory declares a provider the builder can construct", () => {
        const declared = [
            Anthropic(), OpenAI(), Google(), Groq(), Cerebras(), Mistral(),
            DeepSeek(), XAI(), Perplexity(), ZAI(), Moonshot(),
        ]

        for (const entry of declared) {
            expect(DIRECT_PROVIDERS[entry.provider]).toBeDefined()
            expect(() => buildProvider(entry, { cloud, env: {} })).not.toThrow()
        }
    })

    test("a definition's name matches the key it is registered under", () => {
        // HostedProvider filters the catalogue by `route.via === name`, so a
        // key that disagrees with its definition supplies nothing and says
        // nothing about why.
        for (const [key, definition] of Object.entries(DIRECT_PROVIDERS)) {
            expect(definition.name).toBe(key)
        }
    })

    test("every definition names an environment variable", () => {
        for (const definition of Object.values(DIRECT_PROVIDERS)) {
            expect(definition.env).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/)
        }
    })

    test("construction does no work — a provider with no key still builds", () => {
        // Declaring a provider is not a claim to have configured it. A profile
        // listing eight providers must load with none of their keys present.
        expect(() => buildProvider(Anthropic(), { cloud, env: {} })).not.toThrow()
    })

    test("an unknown provider names the ones that exist, including direct routes", () => {
        try {
            buildProvider({ provider: "nope" }, { cloud, env: {} })
            throw new Error("expected a throw")
        } catch (error) {
            const message = (error as Error).message
            expect(message).toContain("PROVIDER_UNKNOWN")
            expect(message).toContain("anthropic")
            expect(message).toContain("ollama")
        }
    })

    test("a user's own key and endpoint ride on the declaration", () => {
        const entry = Anthropic({ key: "sk-test", url: "https://proxy.example" })
        expect(entry).toMatchObject({ provider: "anthropic", key: "sk-test", url: "https://proxy.example" })
    })

    /**
     * Loads every provider package for real.
     *
     * The one check that catches a package renaming its factory export or
     * moving to a spec revision this adapter does not read — both of which
     * are silent until a user's first call otherwise. No network: building a
     * client is local, and no request is made.
     */
    test("every definition loads its package and yields a model this adapter accepts", async () => {
        for (const [name, definition] of Object.entries(DIRECT_PROVIDERS)) {
            const factory = await definition.load("test-key-never-sent")
            const model = factory("some-model-id")

            expect(model.specificationVersion, `${name} specification version`).toBe("v4")
            expect(typeof model.doStream, `${name} doStream`).toBe("function")
            expect(() => AiSdk({ provider: name, model })).not.toThrow()
        }
    })

    test("a compatible-endpoint provider honours a url override", async () => {
        const factory = await DIRECT_PROVIDERS.moonshot!.load("k", "https://proxy.example/v1")
        expect(factory("kimi-k3").specificationVersion).toBe("v4")
    })
})

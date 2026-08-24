import { describe, expect, test } from "bun:test"
import type { AxonEngineDriver, CloudModelCatalog, EngineCloud } from "@arcforge/types"
import { fromModalityString, HostedProvider } from "../src/catalogue"

const driver: AxonEngineDriver = { async *stream() {} }

function cloud(catalogue: CloudModelCatalog): EngineCloud {
    return {
        registry: { models: { async all() { return catalogue } } },
    } as unknown as EngineCloud
}

const catalogue: CloudModelCatalog = {
    models: [
        {
            id: "anthropic/claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            context: 200_000,
            modality: "text+image->text",
            routes: [{ via: "axon", model: "claude-sonnet-4-6" }, { via: "openrouter", model: "anthropic/claude-sonnet-4-6" }],
        },
        {
            id: "openai/gpt-5",
            name: "GPT-5",
            context: 128_000,
            modality: "text->text",
            routes: [{ via: "codex", model: "gpt-5" }],
        },
        {
            id: "broken/model",
            name: "Unclassifiable",
            context: 8_000,
            routes: [{ via: "axon", model: "broken" }],
        },
    ],
    failures: [],
}

describe("fromModalityString", () => {
    test("parses OpenRouter's arrow form", () => {
        expect(fromModalityString("text+image->text")).toEqual({
            type: "generate",
            in: ["text", "image"],
            out: ["text"],
        })
    })

    test("refuses a shape it cannot read", () => {
        expect(fromModalityString("nonsense")).toBeNull()
        expect(fromModalityString(undefined)).toBeNull()
        expect(fromModalityString("->text")).toBeNull()
    })
})

describe("HostedProvider", () => {
    test("supplies only models carrying its own route", async () => {
        const provider = HostedProvider({ name: "codex", cloud: cloud(catalogue), driver: () => driver })

        const supplied = await provider.catalogue()

        expect(supplied.map(c => c.id)).toEqual(["gpt-5"])
    })

    test("uses the route's model id, not the canonical one", async () => {
        const provider = HostedProvider({ name: "axon", cloud: cloud(catalogue), driver: () => driver })

        const supplied = await provider.catalogue()

        expect(supplied[0]?.id).toBe("claude-sonnet-4-6")
    })

    test("carries modalities through from the upstream string", async () => {
        const provider = HostedProvider({ name: "axon", cloud: cloud(catalogue), driver: () => driver })

        const supplied = await provider.catalogue()

        expect(supplied[0]?.in).toEqual(["text", "image"])
    })

    test("a model with no readable modality never enters the catalogue", async () => {
        const provider = HostedProvider({ name: "axon", cloud: cloud(catalogue), driver: () => driver })

        const supplied = await provider.catalogue()

        expect(supplied.some(c => c.id === "broken")).toBe(false)
    })

    test("hosted models are never local", async () => {
        const provider = HostedProvider({ name: "axon", cloud: cloud(catalogue), driver: () => driver })

        expect((await provider.catalogue()).every(c => c.local === false)).toBe(true)
    })

    test("a user's slots ceiling reaches the capability", async () => {
        const provider = HostedProvider({ name: "axon", cloud: cloud(catalogue), driver: () => driver, slots: 2 })

        expect((await provider.catalogue())[0]?.slots).toBe(2)
    })

    test("resolve finds a supplied model and refuses an unknown one", async () => {
        const provider = HostedProvider({ name: "axon", cloud: cloud(catalogue), driver: () => driver })

        expect(await provider.resolve("claude-sonnet-4-6")).not.toBeNull()
        expect(await provider.resolve("nope")).toBeNull()
    })

    test("create builds the driver for the resolved model id", async () => {
        const seen: string[] = []
        const provider = HostedProvider({
            name: "axon",
            cloud: cloud(catalogue),
            driver: model => { seen.push(model); return driver },
        })

        const supplied = await provider.catalogue()
        provider.create(supplied[0]!)

        expect(seen).toEqual(["claude-sonnet-4-6"])
    })
})

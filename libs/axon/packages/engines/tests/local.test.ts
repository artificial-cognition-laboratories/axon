import { afterEach, describe, expect, test } from "bun:test"
import type { AxonEngineDriver } from "@arcforge/types"
import { OllamaProvider } from "../src/catalogue"

const driver: AxonEngineDriver = { async *stream() {} }
const original = globalThis.fetch

afterEach(() => {
    globalThis.fetch = original
})

function daemon(models: unknown[], ok = true): void {
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ models }), { status: ok ? 200 : 500 })) as typeof fetch
}

function down(): void {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED") }) as typeof fetch
}

const provider = () => OllamaProvider({ host: "http://localhost:11434", driver: () => driver })

describe("OllamaProvider", () => {
    test("reports what is pulled on this machine", async () => {
        daemon([
            { name: "qwen3:8b", size: 5_200_000_000, details: { family: "qwen3" } },
        ])

        const supplied = await provider().catalogue()

        expect(supplied).toHaveLength(1)
        expect(supplied[0]?.id).toBe("qwen3:8b")
        expect(supplied[0]?.local).toBe(true)
    })

    test("carries on-disk size for an admission check", async () => {
        daemon([{ name: "qwen3:8b", size: 5_200_000_000, details: { family: "qwen3" } }])

        expect((await provider().catalogue())[0]?.bytes).toBe(5_200_000_000)
    })

    test("leaves context unknown rather than guessing one", async () => {
        daemon([{ name: "qwen3:8b", details: { family: "qwen3" } }])

        expect((await provider().catalogue())[0]?.context).toBeUndefined()
    })

    test("a vision family widens the input modalities", async () => {
        daemon([{ name: "gemma3:4b", details: { family: "gemma3" } }])

        expect((await provider().catalogue())[0]?.in).toEqual(["text", "image"])
    })

    test("a text-only family stays text in", async () => {
        daemon([{ name: "qwen3:8b", details: { family: "qwen3" } }])

        expect((await provider().catalogue())[0]?.in).toEqual(["text"])
    })

    test("a dead daemon throws rather than reporting an empty machine", async () => {
        down()

        await expect(provider().catalogue()).rejects.toThrow()
    })

    test("a non-ok response throws with the status", async () => {
        daemon([], false)

        await expect(provider().catalogue()).rejects.toThrow(/500/)
    })

    test("a machine with nothing pulled is an empty list, not a failure", async () => {
        daemon([])

        expect(await provider().catalogue()).toEqual([])
    })

    test("resolve refuses a model this machine has not pulled", async () => {
        daemon([{ name: "qwen3:8b", details: { family: "qwen3" } }])

        expect(await provider().resolve("qwen3:8b")).not.toBeNull()
        expect(await provider().resolve("llama3:70b")).toBeNull()
    })
})

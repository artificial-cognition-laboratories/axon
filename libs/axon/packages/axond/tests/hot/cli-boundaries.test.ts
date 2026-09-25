import { describe, expect, it } from "bun:test"
import { Renderer } from "@arcforge/arcline"
import { CatalogCommands } from "../../src/control/cli/catalog"
import { Format } from "../../src/control/cli/format"
import { WatchCommands } from "../../src/control/cli/watch"
import type { CliContext } from "../../src/control/cli/types"

function context(axond: unknown, client: unknown): CliContext {
    return { axond: axond as never, client: client as never, renderer: Renderer(), format: Format({}) }
}

describe("daemon CLI boundaries", () => {
    it("rejects an unknown catalog filter before querying a provider", async () => {
        let queried = false
        const axond = {
            lifecycle: { status: () => ({ running: false }) },
            models: { search: async () => { queried = true; return [] }, hasMore: () => false },
        }
        const catalog = CatalogCommands(context(axond, {}))

        await expect(catalog.catalog("llama", "unknown")).rejects.toMatchObject({ code: "AX-MODEL-041" })
        await expect(catalog.catalog("llama", "chat", true, false, "unknown")).rejects.toMatchObject({ code: "AX-MODEL-041" })
        expect(queried).toBe(false)
    })

    it("passes validated catalog filters to the model domain", async () => {
        let received: unknown
        const axond = {
            lifecycle: { status: () => ({ running: false }) },
            models: {
                search: async (input: unknown) => { received = input; return [] },
                hasMore: () => false,
            },
        }
        const result = await CatalogCommands(context(axond, {})).catalog("llama", "chat", true, false, "downloads", true)
        expect(received).toEqual({ query: "llama", capability: "chat", sort: "downloads", fitsOnly: true })
        expect(JSON.parse(result)).toMatchObject({ query: "llama", models: [] })
    })

    it("ends a live watch with an error record when the daemon disappears", async () => {
        let polls = 0
        const axond = {
            lifecycle: { status: () => ({ running: true }) },
            models: { refresh: async () => {} },
            boot: { unit: () => ({ supported: true }), installed: () => true },
            agents: { list: () => [] },
        }
        const client = {
            machine: {
                watching: async () => { if (++polls > 1) throw new Error("daemon disconnected") },
                state: async () => ({}),
            },
            models: { state: async () => ({}) },
            jobs: { state: async () => ({ jobs: [] }) },
            agents: { installed: async () => [] },
            identity: { read: async () => ({}) },
            preferences: { all: async () => ({}) },
            dictation: { state: async () => ({ recording: false }) },
        }
        const previous = process.exitCode
        let resolveError: (value: { error: { message: string } }) => void = () => {}
        const errorLine = new Promise<{ error: { message: string } }>(resolve => { resolveError = resolve })
        const stop = await WatchCommands(context(axond, client)).watch(line => {
            const frame = JSON.parse(line) as { error?: { message: string } }
            if (frame.error) resolveError({ error: frame.error })
        }, 5)
        try {
            const frame = await Promise.race([
                errorLine,
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("watch did not report its failure")), 500)),
            ])
            expect(frame.error.message).toBe("daemon disconnected")
            expect(process.exitCode).toBe(1)
        } finally {
            stop()
            process.exitCode = previous
        }
    })
})

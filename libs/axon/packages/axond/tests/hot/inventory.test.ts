import { describe, expect, it } from "bun:test"
import { Adapters, type ModelAdapter } from "../../src/models/adapter"
import { Inventory } from "../../src/models/inventory"

/**
 * What the machine offers roles. A brain's declared vision models landed on
 * disk, fully described, and were never offered — the catalogue only knew
 * chat. These pin both halves: transforms by their modalities, chat by its
 * own narrower rule.
 */

function entry(specifier: string, path: string, traits: Record<string, unknown>) {
    return { specifier: specifier, bytes: 1000, path: path, traits: traits }
}

function inventory(entries: ReturnType<typeof entry>[]) {
    const runs: ModelAdapter = { runtime: "transformers", claims: path => path.startsWith("/runnable"), load: async () => { throw new Error("not loaded in this test") } }
    return Inventory({ store: { list: async () => entries } as never, adapters: Adapters([runs]) })
}

describe("inventory — what the machine offers", () => {
    it("offers a runnable transform by what it takes and gives", async () => {
        const offered = await inventory([
            entry("hf:dino", "/runnable/dino", { capability: "vision", type: "transform", in: ["image"], out: ["features"] }),
        ]).local()
        expect(offered).toEqual([expect.objectContaining({ id: "hf:dino", type: "transform", in: ["image"], out: ["features"], provider: "local" })])
    })

    it("keeps chat to models that hold a conversation", async () => {
        const offered = await inventory([
            entry("hf:chat", "/runnable/chat", { capability: "chat", type: "generate", in: ["text"], out: ["text"] }),
            entry("hf:captioner", "/runnable/cap", { capability: "vision", type: "generate", in: ["image"], out: ["text"] }),
        ]).local()
        expect(offered.map(model => model.id)).toEqual(["hf:chat"])
    })

    it("offers nothing no runtime here can execute, or that does not say what it takes", async () => {
        const offered = await inventory([
            entry("hf:elsewhere", "/unclaimed/x", { capability: "vision", type: "transform", in: ["image"], out: ["features"] }),
            entry("hf:silent", "/runnable/y", { capability: "other", type: "transform" }),
        ]).local()
        expect(offered).toEqual([])
    })
})

/**
 * An unreadable model store must never look like an empty one — locally or to
 * a machine asking remotely. The fault is held until a refresh succeeds.
 */
describe("inventory — a store that cannot be read", () => {
    it("throws to readers rather than reading as no models", async () => {
        const broken = new Error("EACCES: models store")
        const held = Inventory({ store: { list: async () => { throw broken } } as never, adapters: Adapters([]) })

        await expect(held.refresh()).rejects.toBe(broken)
        expect(() => held.current).toThrow(broken)
    })

    it("clears the fault once a refresh succeeds", async () => {
        let fail = true
        const held = Inventory({ store: { list: async () => { if (fail) throw new Error("flaky"); return [] } } as never, adapters: Adapters([]) })

        await expect(held.refresh()).rejects.toThrow("flaky")
        fail = false
        await held.refresh()
        expect(held.current).toEqual([])
    })
})

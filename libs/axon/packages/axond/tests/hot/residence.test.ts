import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Activity } from "../../src/models/activity"
import { Adapters, type ModelAdapter } from "../../src/models/adapter"
import { Residence } from "../../src/models/residence"

/**
 * Keep-warm: a weight the daemon loaded to serve inference is let go once
 * nothing has used it for a while. Before this, a stopped agent's models
 * stayed on the GPU until the daemon itself exited.
 */

const KEEP = 1_000

function residence() {
    let clock = 0
    const unloaded: string[] = []
    const adapter: ModelAdapter = {
        runtime: "transformers",
        claims: () => true,
        load: async path => ({
            bytes: 10,
            engine: "transform",
            transform: async input => input,
            run: async input => input,
            unload: async () => { unloaded.push(path) },
        }),
    }
    const records = ["dino", "sam"].map(id => ({ id: id, path: `/models/${id}`, bytes: 10 }))
    const home = Residence({
        inventory: { current: records, refresh: async () => records } as never,
        adapters: Adapters([adapter]),
        machine: { admit: () => ({ ok: true }), residency: { take: () => ({ id: "hold" }), release: () => {} } } as never,
        activity: Activity({ path: join(mkdtempSync(join(tmpdir(), "axon-residence-")), "events.jsonl") }),
        keepWarmMs: KEEP,
        now: () => clock,
    })
    return { home: home, unloaded: unloaded, advance: (ms: number) => { clock += ms } }
}

describe("residence — keep-warm", () => {
    test("lets go of a weight it loaded for inference once nothing has used it for a while", async () => {
        const { home, unloaded, advance } = residence()
        await home.run({ model: "dino", input: 1 })
        expect(home.has("dino")).toBe(true)

        advance(KEEP / 2)
        await home.run({ model: "dino", input: 2 })
        advance(KEEP / 2 + 1)
        expect(await home.expire()).toEqual([])

        advance(KEEP)
        expect(await home.expire()).toEqual(["dino"])
        expect(home.has("dino")).toBe(false)
        expect(unloaded).toEqual(["/models/dino"])
        await home.dispose()
    })

    test("never expires a weight a person loaded", async () => {
        const { home, advance } = residence()
        await home.pin("sam")
        advance(KEEP * 10)
        expect(await home.expire()).toEqual([])
        expect(home.has("sam")).toBe(true)
        await home.dispose()
    })

    test("a person pinning an autoloaded weight makes it theirs", async () => {
        const { home, advance } = residence()
        await home.run({ model: "sam", input: 1 })
        await home.pin("sam")
        advance(KEEP * 10)
        expect(await home.expire()).toEqual([])
        await home.dispose()
    })
})

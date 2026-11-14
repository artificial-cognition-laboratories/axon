import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Interventions } from "../../src/labs/interventions"

const roots: string[] = []
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })

test("lab interventions survive reopening and record a refused world action", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-lab-interventions-"))
    roots.push(root)
    const action = { kind: "spawn" as const, world: "town", entity: "zombie" as const, x: 300, y: 400 }
    const first = Interventions({ root: root, execute: async input => ({ at: Date.now(), world: input.world, action: input, result: "spawned" }) })
    await first.act(action)
    const reopened = Interventions({ root: root, execute: async () => { throw new Error("world stopped") } })
    await expect(reopened.act(action)).rejects.toThrow("world stopped")
    const history = await reopened.history()
    expect(history.map(item => item.status)).toEqual(["failed", "succeeded"])
    expect(history[0]?.detail).toBe("world stopped")
    expect(history[1]?.action).toEqual(action)
})

import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "../../src/build/blueprint"

test("config reads authored edits without a watcher invalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-config-refresh-"))
    try {
        const path = join(root, "axon.config.ts")
        await writeFile(path, "export default defineAgent({ workspace: true })\n")
        expect((await Config(root)).value.workspace).toBe(true)
        await writeFile(path, "export default defineAgent({ workspace: false })\n")
        expect((await Config(root)).value.workspace).toBe(false)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("config evaluates external inputs on each load", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-config-inputs-"))
    try {
        // The same source has different inputs on each evaluation. Its bytes
        // alone cannot establish cache validity for executable user code.
        await writeFile(join(root, "axon.config.ts"),
            "export default defineAgent({ links: { probe: '/' + crypto.randomUUID() } })\n")
        const first = await Config(root)
        const second = await Config(root)
        expect(second.value.links).not.toEqual(first.value.links)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

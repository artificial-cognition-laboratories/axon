import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateEngineField } from "../../src/build/project/manifest/engine-migrate"

/**
 * Removing the dead `engine:` field from an agent already on disk.
 *
 * `engine:` is fatal at load now, which is correct — an agent carrying it was
 * silently running on a different, billed provider than its config named. But
 * every agent already on someone's machine carries it, and the largest
 * population is zeno, which most users never wrote by hand and have no reason
 * to know how to repair. So it is removed for them on the next prepare.
 *
 * This edits a file the USER owns, so what it must never do is as important as
 * what it does: everything around the removed line survives byte-identical, and
 * a config the author has already migrated is not touched at all.
 */

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "engine-migrate-"))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

async function config(body: string): Promise<void> {
    await writeFile(join(dir, "axon.config.ts"), body)
}

async function read(): Promise<string> {
    return readFile(join(dir, "axon.config.ts"), "utf-8")
}

describe("engine: migration", () => {
    it("removes a bare engine call", async () => {
        await config(`export default defineAgent({
    engine: Axon(),
    modules: ["@axon/fs"],
})
`)

        const result = await migrateEngineField(dir)

        expect(result.migrated).toBe(true)
        expect(await read()).toBe(`export default defineAgent({
    modules: ["@axon/fs"],
})
`)
    })

    it("carries a named model across as a model: preference", async () => {
        // The one thing the old call could express that dropping the line
        // would lose. Without this the agent declares no preference and the
        // resolver picks from the pool — a different model than the config
        // named.
        await config(`export default defineAgent({
    engine: Codex({ model: "gpt-5.6-terra" }),
})
`)

        const result = await migrateEngineField(dir)

        expect(result.model).toBe("codex:gpt-5.6-terra")
        expect(await read()).toContain(`model: "codex:gpt-5.6-terra",`)
    })

    it("keeps the author's own model: when both are present", async () => {
        // `model:` is the field the runtime actually reads, so the author
        // wrote it deliberately and it outranks anything recovered from a call
        // that was being ignored.
        await config(`export default defineAgent({
    model: "axon:openai/gpt-5.6-luna",
    engine: Codex({ model: "gpt-5.6-terra" }),
})
`)

        await migrateEngineField(dir)

        const source = await read()
        expect(source).toContain(`model: "axon:openai/gpt-5.6-luna"`)
        expect(source).not.toContain("gpt-5.6-terra")
        expect(source).not.toContain("engine:")
    })

    it("survives a nested option object without truncating the call", async () => {
        // The scan walks parens and braces: matching the first ")" would cut
        // the declaration in half and leave a syntax error in the user's file.
        await config(`export default defineAgent({
    engine: Axon({ model: "auto", optimize: { cost: 1, speed: 0.5 } }),
    modules: ["@axon/fs"],
})
`)

        await migrateEngineField(dir)

        const source = await read()
        expect(source).not.toContain("engine:")
        expect(source).not.toContain("optimize")
        expect(source).toContain(`modules: ["@axon/fs"],`)
    })

    it("leaves everything around the line byte-identical", async () => {
        // The file is the author's own TypeScript. Comments, imports and
        // formatting are theirs and must come through untouched.
        await config(`// https://axon.arclabs.it/docs/v2/agent/config
import { helper } from "./lib/helper"

export default defineAgent({
    // the brain that thinks
    engine: Axon(),
    modules: [
        "@axon/fs",
        "@axon/subagent",
    ],
    hooks: { onBoot: helper },
})
`)

        await migrateEngineField(dir)

        expect(await read()).toBe(`// https://axon.arclabs.it/docs/v2/agent/config
import { helper } from "./lib/helper"

export default defineAgent({
    // the brain that thinks
    modules: [
        "@axon/fs",
        "@axon/subagent",
    ],
    hooks: { onBoot: helper },
})
`)
    })

    it("writes the model at the removed line's own indentation", async () => {
        // The replacement takes the declaration's place, so it has to inherit
        // its indent — an unindented field in the middle of an indented object
        // is the tell that the edit was mechanical rather than authored.
        await config(`// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    engine: Axon({ model: "openai/gpt-5.6-luna" }),
    modules: [
        "@axon/fs",
    ],
})
`)

        await migrateEngineField(dir)

        // Byte-for-byte what a current zeno config looks like.
        expect(await read()).toBe(`// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    model: "axon:openai/gpt-5.6-luna",
    modules: [
        "@axon/fs",
    ],
})
`)
    })

    it("drops a Mock engine without inventing a model", async () => {
        // Mock has no catalogue to pin against, so there is no preference to
        // carry — the line simply goes.
        await config(`export default defineAgent({
    engine: Mock(),
})
`)

        const result = await migrateEngineField(dir)

        expect(result.migrated).toBe(true)
        expect(result.model).toBeUndefined()
        expect(await read()).not.toContain("Mock")
    })

    it("does not touch a config that never declared engine:", async () => {
        // The common case, and the one that must cost nothing: every config
        // written after the field was retired.
        const original = `export default defineAgent({
    model: "axon:openai/gpt-5.6-luna",
    modules: ["@axon/fs"],
})
`
        await config(original)

        const result = await migrateEngineField(dir)

        expect(result.migrated).toBe(false)
        expect(await read()).toBe(original)
    })

    it("is idempotent — a second run is a no-op", async () => {
        await config(`export default defineAgent({
    engine: Codex({ model: "gpt-5.6-terra" }),
})
`)

        await migrateEngineField(dir)
        const once = await read()
        const second = await migrateEngineField(dir)

        expect(second.migrated).toBe(false)
        expect(await read()).toBe(once)
    })

    it("reports nothing for a directory with no config at all", async () => {
        expect((await migrateEngineField(dir)).migrated).toBe(false)
    })
})

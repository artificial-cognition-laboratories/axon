import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Blueprint } from "../../src/build/blueprint"

/**
 * `engine:` is deprecated and read by nothing.
 *
 * The failure this guards against is SILENT: an agent that declares
 * `engine: Codex({ model })` still boots, resolving inference against the
 * profile pool instead, while its config claims otherwise. The warning is the
 * only signal the author gets. If it stops firing, every such agent goes back
 * to lying about what it runs on.
 */

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "axon-engine-dep-"))
    await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "engine-dep-probe", version: "0.1.0" }),
    )
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

async function config(body: string): Promise<void> {
    await writeFile(join(dir, "axon.config.ts"), body)
}

/** The deprecation warning, if the load produced one. */
async function deprecation() {
    const { warnings } = await Blueprint({ root: dir }).load({})
    return warnings.find(warning => warning.cause?.code === "AX-PROJECT-033")
}

describe("engine: deprecation", () => {
    it("warns when the config still declares engine:", async () => {
        await config(`export default defineAgent({ engine: Mock() })\n`)

        const warning = await deprecation()

        expect(warning).toBeDefined()
        expect(warning?.domain).toBe("config")
    })

    it("names both replacements, so the author can act on it", async () => {
        await config(`export default defineAgent({ engine: Codex() })\n`)

        const warning = await deprecation()

        expect(warning?.cause?.description).toContain("model:")
        expect(warning?.cause?.description).toContain("providers:")
    })

    it("warns but does not throw — the agent still loads", async () => {
        await config(`export default defineAgent({ engine: Mock() })\n`)

        const { blueprint } = await Blueprint({ root: dir }).load({})

        expect(blueprint.agent.name).toBe("engine-dep-probe")
    })

    it("stays silent for a config using model:", async () => {
        await config(`export default defineAgent({ model: "codex:gpt-5.6-terra" })\n`)

        expect(await deprecation()).toBeUndefined()
    })

    it("stays silent for a config using providers:", async () => {
        await config(`export default defineAgent({ providers: [Mock()] })\n`)

        expect(await deprecation()).toBeUndefined()
    })

    it("stays silent for a config declaring no inference at all", async () => {
        await config(`export default defineAgent({})\n`)

        expect(await deprecation()).toBeUndefined()
    })
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Blueprint } from "../../src/build/blueprint"

/**
 * `engine:` is removed, and loading a config that declares it is REFUSED.
 *
 * It used to warn and load anyway, on the reasoning that such an agent
 * already booted on the profile pool so refusing would break working agents
 * over an ignored field. What that missed is what "boots on the profile pool"
 * means: the agent runs on a DIFFERENT, BILLED provider than its config names,
 * and nothing downstream can tell the difference. Nine test fixtures across
 * this repo declared `engine: Mock()` and made real paid inference calls on
 * every run for exactly as long as this was a warning — the mock they asked
 * for was silently swapped for a live provider.
 *
 * So the failure these guard is no longer "the warning stopped firing" but
 * "the refusal stopped firing", which is the same bug with the stakes made
 * visible.
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

/** Load, returning the error it refused with — or null if it loaded. */
async function refusal(): Promise<{ code?: string; description?: string } | null> {
    try {
        await Blueprint({ root: dir }).load({})
        return null
    } catch (cause) {
        return cause as { code?: string; description?: string }
    }
}

describe("engine: removal", () => {
    it("refuses a config that still declares engine:", async () => {
        await config(`export default defineAgent({ engine: Mock() })\n`)

        expect((await refusal())?.code).toBe("AX-PROJECT-033")
    })

    it("names both replacements, so the author can act on it", async () => {
        await config(`export default defineAgent({ engine: Codex() })\n`)

        const error = await refusal()

        expect(error?.description).toContain("model:")
        expect(error?.description).toContain("providers:")
    })

    it("refuses rather than silently running on another provider", async () => {
        // The whole point. A config naming a mock that loads anyway resolves
        // against the profile pool — a real, billed provider — while the
        // author believes no network call is possible.
        await config(`export default defineAgent({ engine: Mock() })\n`)

        expect(await refusal()).not.toBeNull()
    })

    it("loads a config using model:", async () => {
        await config(`export default defineAgent({ model: "codex:gpt-5.6-terra" })\n`)

        expect(await refusal()).toBeNull()
    })

    it("loads a config using providers:", async () => {
        await config(`export default defineAgent({ providers: [Mock()] })\n`)

        expect(await refusal()).toBeNull()
    })

    it("loads a config declaring no inference at all", async () => {
        await config(`export default defineAgent({})\n`)

        expect(await refusal()).toBeNull()
    })
})

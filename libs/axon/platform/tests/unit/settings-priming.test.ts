import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "@arcforge/platform/store"

/**
 * Watched paths are only real once settings have been LOADED.
 *
 * The store caches settings synchronously, because `extraRoots()` is sync and
 * so is every caller of it — but reading them evaluates the user's
 * `profile.config.ts`, which is async and therefore cannot happen during
 * construction. Something has to prime the cache, once, before anything
 * resolves an agent by name.
 *
 * Nothing did, twice: the CLI dispatched with an empty cache, and later the
 * TUI booted with one. Both failed identically and confusingly — every
 * watched checkout invisible, `AGENT_NOT_FOUND` naming only the installed
 * pool, and no hint that a whole search root had silently gone missing.
 *
 * These pin the DIFFERENCE the priming makes, which is the fact both bugs
 * turned on. The entry points that must do the priming are asserted
 * separately (see cli-priming.test.ts) — this is the store-level property
 * they depend on.
 */

const PROFILE = "test@axon.dev"

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "axon-priming-"))
    const store = (settings: { paths?: string[] }) => {
        const s = Store({ root, settings: () => settings, setSetting: async () => {} })
        s.profiles.save(PROFILE, { user: { email: PROFILE } } as never)
        return s
    }
    const watched = join(root, "checkout")
    await mkdir(join(watched, "barry"), { recursive: true })
    await writeFile(join(watched, "barry", "axon.config.ts"), "export default defineAgent({})\n")
    await writeFile(join(watched, "barry", "package.json"), JSON.stringify({ name: "@cody/barry" }))
    await mkdir(join(root, "profiles", PROFILE, "agents"), { recursive: true })
    return { root, store, watched, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("settings priming — watched paths need a loaded config", () => {
    it("an UNPRIMED cache sees no watched pools at all", async () => {
        const f = await fixture()
        // `{}` is what the cache holds before anything loads the config —
        // the state both the CLI and the TUI booted in.
        const agents = f.store(({} as { paths?: string[] })).profiles.active()!.agents

        expect(agents.extraRoots()).toEqual([])
        // Only the installed pool. This is the exact `searched` list the
        // AGENT_NOT_FOUND error printed while a checkout sat right there.
        expect(agents.pools().map(p => p.kind)).toEqual(["installed"])
        expect(agents.find("@cody/barry")).toEqual([])

        await f.cleanup()
    })

    it("a PRIMED cache sees the watched pool and finds what is in it", async () => {
        const f = await fixture()
        const agents = f.store({ paths: [f.watched] }).profiles.active()!.agents

        expect(agents.extraRoots()).toEqual([f.watched])
        expect(agents.pools().map(p => p.kind)).toEqual(["watched", "installed"])

        const found = agents.find("@cody/barry")
        expect(found).toHaveLength(1)
        expect(found[0]!.root).toBe(join(f.watched, "barry"))
        expect(found[0]!.kind).toBe("watched")

        await f.cleanup()
    })

    it("reads the cache live, so priming after construction still takes effect", async () => {
        // The thunk exists precisely so the store can be built before the
        // config is readable. A snapshot taken at construction would make
        // priming a no-op — and the failure would look identical to not
        // priming at all.
        const f = await fixture()
        const settings: { paths?: string[] } = {}
        const agents = f.store(settings).profiles.active()!.agents

        expect(agents.find("@cody/barry")).toEqual([])

        settings.paths = [f.watched] // what refreshSettings() does

        expect(agents.find("@cody/barry")).toHaveLength(1)

        await f.cleanup()
    })
})

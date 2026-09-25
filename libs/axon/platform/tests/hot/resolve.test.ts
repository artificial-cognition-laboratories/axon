import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Resolve } from "@arcforge/platform/build/runtime"
import { Store } from "@arcforge/platform/store"

/**
 * Resolve turns an agent reference into a directory, using LOCAL POOLS ONLY.
 * Two reference forms, two contracts:
 *
 *   a path   states WHERE the agent is — a miss is the caller's mistake
 *   a name   asks us to look — watched checkouts first, then installed
 *
 * A scoped name (`@cody/barry`) is a name, not a path and not a registry
 * instruction: the scope is part of the agent's IDENTITY. Nothing here ever
 * reaches the network, which is the property most of these tests exist to
 * pin down — `axon install` is the only thing that fetches.
 *
 * Everything goes through the public surface: a real Store on a temp root
 * and real directories on disk.
 */

const PROFILE = "test@axon.dev"

/**
 * A directory that is an agent. `name` is the identity in package.json —
 * what find() matches on — which is deliberately allowed to differ from the
 * directory it sits in, because that difference is the whole point.
 */
async function agentDir(root: string, dir: string, name?: string): Promise<string> {
    const path = join(root, dir)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, "axon.config.ts"), "export default defineAgent({})\n")
    await writeFile(join(path, "package.json"), JSON.stringify({ name: name ?? dir }))
    return path
}

/** A Store on a throwaway root with one active profile, plus its agents dir. */
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "axon-resolve-"))
    // A real settings pair, in memory. Store refuses to write watch paths
    // without one (SETTINGS_NOT_WRITABLE) rather than saving somewhere the
    // read path never looks — so a test that watches has to supply it, the
    // same way profile.config.ts does in production.
    const settings: { paths?: string[] } = {}
    const store = Store({
        root,
        settings: () => settings,
        setSetting: async (key, value) => {
            if (key === "paths") settings.paths = value as string[]
            return value
        },
    })
    store.profiles.save(PROFILE, { user: { email: PROFILE } } as never)
    const agentsRoot = join(root, "profiles", PROFILE, "agents")
    await mkdir(agentsRoot, { recursive: true })
    return { root, store, agentsRoot, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("Resolve", () => {
    describe("paths", () => {
        test("resolves a relative path against the caller's cwd, not the agent's", async () => {
            const f = await fixture()
            const scripts = join(f.root, "scripts")
            await mkdir(scripts, { recursive: true })
            const dave = await agentDir(f.root, "dave")

            const resolve = Resolve({ store: f.store, cwd: scripts })
            const resolved = await resolve.one("../dave")

            expect(resolved.root).toBe(dave)
            expect(resolved.kind).toBe("path")
            expect(resolved.pool).toBe("path")
            await f.cleanup()
        })

        test("resolves an absolute path", async () => {
            const f = await fixture()
            const dave = await agentDir(f.root, "dave")

            const resolve = Resolve({ store: f.store, cwd: f.root })
            expect((await resolve.one(dave)).root).toBe(dave)
            await f.cleanup()
        })

        test("a path with no agent throws rather than searching elsewhere", async () => {
            const f = await fixture()
            // Same name exists as an installed agent — a path must not fall
            // back to it, or "where the agent is" stops meaning anything.
            await agentDir(f.agentsRoot, "dave")

            const resolve = Resolve({ store: f.store, cwd: f.root })
            await expect(resolve.one("./dave")).rejects.toThrow()
            await f.cleanup()
        })
    })

    describe("names", () => {
        test("finds an installed agent", async () => {
            const f = await fixture()
            const barry = await agentDir(f.agentsRoot, "barry")

            const resolve = Resolve({ store: f.store, cwd: f.root })
            const resolved = await resolve.one("barry")

            expect(resolved.root).toBe(barry)
            expect(resolved.kind).toBe("name")
            expect(resolved.pool).toBe("installed")
            await f.cleanup()
        })

        test("finds an agent in a watched path", async () => {
            const f = await fixture()
            const elsewhere = join(f.root, "work")
            const scout = await agentDir(elsewhere, "scout")
            await f.store.profiles.active()!.agents.watch(elsewhere)

            const resolve = Resolve({ store: f.store, cwd: f.root })
            const resolved = await resolve.one("scout")

            expect(resolved.root).toBe(scout)
            expect(resolved.pool).toBe("watched")
            await f.cleanup()
        })

        test("an unknown name throws", async () => {
            const f = await fixture()
            const resolve = Resolve({ store: f.store, cwd: f.root })
            await expect(resolve.one("nobody")).rejects.toThrow()
            await f.cleanup()
        })
    })

    describe("identity", () => {
        test("a scoped ref matches the name in package.json, not the directory", async () => {
            const f = await fixture()
            // The regression this whole shape exists for: the directory is
            // `barry.mk3`, the agent is `@cody/barry.mk3`.
            const barry = await agentDir(f.agentsRoot, "barry.mk3", "@cody/barry.mk3")

            const resolve = Resolve({ store: f.store, cwd: f.root })
            expect((await resolve.one("@cody/barry.mk3")).root).toBe(barry)
            await f.cleanup()
        })

        test("a scoped ref does not match a different scope's agent", async () => {
            const f = await fixture()
            await agentDir(f.agentsRoot, "barry", "@alice/barry")

            const resolve = Resolve({ store: f.store, cwd: f.root })
            await expect(resolve.one("@cody/barry")).rejects.toThrow()
            await f.cleanup()
        })

        test("an unscoped ref matches a scoped agent's trailing segment", async () => {
            const f = await fixture()
            const barry = await agentDir(f.agentsRoot, "barry", "@cody/barry")

            const resolve = Resolve({ store: f.store, cwd: f.root })
            expect((await resolve.one("barry")).root).toBe(barry)
            await f.cleanup()
        })

        test("a version pin narrows nothing locally and still resolves", async () => {
            const f = await fixture()
            const zeno = await agentDir(f.agentsRoot, "zeno", "@axon/zeno")

            const resolve = Resolve({ store: f.store, cwd: f.root })
            expect((await resolve.one("@axon/zeno@1.4.0")).root).toBe(zeno)
            await f.cleanup()
        })
    })

    describe("precedence", () => {
        test("a watched checkout wins over an installed copy of the same agent", async () => {
            const f = await fixture()
            // The bug: editing the checkout did nothing, because a stale
            // install answered first.
            await agentDir(f.agentsRoot, "barry", "@cody/barry")
            const elsewhere = join(f.root, "git")
            const checkout = await agentDir(elsewhere, "barry", "@cody/barry")
            await f.store.profiles.active()!.agents.watch(elsewhere)

            const resolve = Resolve({ store: f.store, cwd: f.root })
            const resolved = await resolve.one("@cody/barry")

            expect(resolved.root).toBe(checkout)
            expect(resolved.pool).toBe("watched")
            await f.cleanup()
        })

        test("two agents in the SAME tier under one bare name is ambiguous, never guessed", async () => {
            const f = await fixture()
            const one = join(f.root, "a")
            const two = join(f.root, "b")
            await agentDir(one, "barry", "@cody/barry")
            await agentDir(two, "barry-fork", "@cody/barry")
            const agents = f.store.profiles.active()!.agents
            await agents.watch(one)
            await agents.watch(two)

            const resolve = Resolve({ store: f.store, cwd: f.root })
            await expect(resolve.one("@cody/barry")).rejects.toThrow()
            await f.cleanup()
        })

        test("different agents under one name in different scopes both resolve", async () => {
            const f = await fixture()
            const cody = await agentDir(f.agentsRoot, "barry", "@cody/barry")
            const elsewhere = join(f.root, "work")
            const alice = await agentDir(elsewhere, "barry", "@alice/barry")
            await f.store.profiles.active()!.agents.watch(elsewhere)

            const resolve = Resolve({ store: f.store, cwd: f.root })

            expect((await resolve.one("@cody/barry")).root).toBe(cody)
            expect((await resolve.one("@alice/barry")).root).toBe(alice)
            // The bare form matches both, and tier precedence settles it:
            // the watched checkout is what is being worked on. Scoping the
            // ref is how you say otherwise.
            expect((await resolve.one("barry")).root).toBe(alice)
            await f.cleanup()
        })
    })

    describe("resolving a set", () => {
        test("resolves every member, keyed by the caller's names", async () => {
            const f = await fixture()
            const barry = await agentDir(f.agentsRoot, "barry")
            const checker = await agentDir(f.root, "checker")

            const resolve = Resolve({ store: f.store, cwd: f.root })
            const set = await resolve.all({ barry: "barry", checker: "./checker" })

            expect(set.barry.root).toBe(barry)
            expect(set.checker.root).toBe(checker)
            await f.cleanup()
        })

        test("one bad reference rejects the whole set", async () => {
            const f = await fixture()
            await agentDir(f.agentsRoot, "barry")

            const resolve = Resolve({ store: f.store, cwd: f.root })
            await expect(resolve.all({ barry: "barry", missing: "nobody" })).rejects.toThrow()
            await f.cleanup()
        })
    })
})

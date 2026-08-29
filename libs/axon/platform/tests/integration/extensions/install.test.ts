import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../setup/user"

/**
 * Installing an extension: fetch it, and record it in `profile.config.ts`.
 *
 * The whole loop is under test here rather than its halves, because the failure
 * that matters is between them — a config naming an extension that is not on
 * disk reports an error on every boot until someone edits the file by hand, and
 * a directory nothing declares is dead weight the user cannot see.
 *
 * These publish a real artifact to local staging and install it back, so the
 * registry round trip is exercised rather than mocked.
 */

function disposableName(): string {
    return `@${TEST_USER.username}/test-inst-${crypto.randomUUID().slice(0, 8)}`
}

type Fixture = {
    platform: ReturnType<typeof Platform>
    /** Publishes a throwaway extension and returns its registry name. */
    publish: () => Promise<string>
}

async function withProfile(fn: (ctx: Fixture) => Promise<void>): Promise<void> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const workDir = await mkdtemp(join(tmpdir(), "axon-test-work-"))
    try {
        const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
        seed.store.profiles.save(TEST_USER.id, {
            user: { id: TEST_USER.id, email: TEST_USER.email },
            auth: { apiKey: TEST_USER.apiKey },
        })

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
        await platform.profile.ensure()

        await fn({
            platform,
            publish: async () => {
                const name = disposableName()
                const project = await platform.projects.create("extension", { name, dir: workDir })
                await project.publish()
                return name
            },
        })
    } finally {
        await rm(storeDir, { recursive: true, force: true })
        await rm(workDir, { recursive: true, force: true })
    }
}

describe("extension install", () => {
    test("fetches a published extension and declares it", async () => {
        await withProfile(async ({ platform, publish }) => {
            const name = await publish()

            const result = await platform.extensions.install(name)

            // Both halves, in this order: on disk first, declared second. A
            // config pointing at nothing is worse than no config entry at all.
            expect(existsSync(join(result.root, "extension.config.ts"))).toBe(true)
            expect(result.declared).toBe(true)

            // PINNED — install resolves the version and writes it into the
            // entry, so a config is reproducible and two profiles can hold
            // different versions without either drifting.
            expect(result.ref).toMatch(new RegExp(`^${name}@`))
            expect(await platform.extensions.list()).toEqual([result.ref])

            // And it lives in the MACHINE store, not under the profile.
            expect(result.root.startsWith(platform.profile.root)).toBe(false)
        })
    }, 120_000)

    test("a local path is declared without being fetched", async () => {
        await withProfile(async ({ platform }) => {
            const root = platform.profile.root
            const dir = join(root, "extensions", "mine")
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, "extension.config.ts"), "export default defineExtension({})\n")

            await platform.extensions.install("./extensions/mine")

            // Nothing to download — a path the user wrote is already there, and
            // creating something at it would be inventing an extension.
            expect(await platform.extensions.list()).toContain("./extensions/mine")
        })
    }, 120_000)

    test("installing a local path that does not exist is refused", async () => {
        await withProfile(async ({ platform }) => {
            expect(platform.extensions.install("./extensions/ghost")).rejects.toThrow()

            // Nothing was declared: the config must never name something that
            // will fail to load on every boot.
            expect(await platform.extensions.list()).toEqual([])
        })
    }, 120_000)

    test("reinstalling refetches without duplicating the entry", async () => {
        await withProfile(async ({ platform, publish }) => {
            const name = await publish()
            const first = await platform.extensions.install(name)

            const again = await platform.extensions.install(first.ref)

            // `declared: false` says the config already had it. The second
            // install is also a CACHE HIT — the version is already in the
            // machine store, so nothing is refetched. That is the whole point
            // of the shared store, and what makes a second profile instant.
            expect(again.declared).toBe(false)
            expect(again.ref).toBe(first.ref)
            expect(await platform.extensions.list()).toEqual([first.ref])
        })
    }, 120_000)

    test("boot fetches an extension the config declares but disk is missing", async () => {
        await withProfile(async ({ platform, publish }) => {
            const name = await publish()
            const { root } = await platform.extensions.install(name)

            // The state a user arrives in after cloning their dotfiles: the
            // config lists it, the machine has never seen it.
            await rm(root, { recursive: true, force: true })
            expect(existsSync(root)).toBe(false)

            const registered: string[] = []
            ;(globalThis as Record<string, unknown>).commands = {
                register: (path: unknown) => { registered.push(String(path)); return () => {} },
            }

            const result = await platform.extensions.load()

            expect(existsSync(root)).toBe(true)
            expect(result.errors).toEqual([])
            platform.extensions.unload()
        })
    }, 120_000)

    test("uninstall undeclares but leaves the shared copy alone", async () => {
        await withProfile(async ({ platform, publish }) => {
            const name = await publish()
            const { root, ref } = await platform.extensions.install(name)

            // Matched on NAME even though the entry is pinned — a user
            // removing an extension should not have to look up which version
            // they have.
            expect(await platform.extensions.uninstall(name)).toEqual({ changed: true, removed: false })
            expect(await platform.extensions.list()).not.toContain(ref)

            // The files stay. They live in a MACHINE-WIDE store, so deleting
            // them would rip the extension out from under another profile that
            // is still using it — a terminal breaking because of something
            // done in an unrelated one. Reclaiming disk is `axon ext prune`.
            expect(existsSync(root)).toBe(true)
        })
    }, 120_000)

    test("uninstall never deletes a LOCAL extension's files", async () => {
        await withProfile(async ({ platform }) => {
            // Source the user wrote. `uninstall` means "stop loading this";
            // deleting it would be unrecoverable, and no install can restore it.
            const root = join(platform.profile.root, "mine")
            await mkdir(root, { recursive: true })
            await writeFile(join(root, "extension.config.ts"), "export default defineExtension({})\n")
            await writeFile(join(root, "main.ts"), "// mine\n")

            await platform.extensions.install("./mine")
            expect(await platform.extensions.uninstall("./mine")).toEqual({ changed: true, removed: false })

            expect(await platform.extensions.list()).not.toContain("./mine")
            expect(existsSync(join(root, "main.ts"))).toBe(true)
        })
    }, 120_000)

    test("a second profile installing the same version reuses the fetched copy", async () => {
        await withProfile(async ({ platform, publish }) => {
            const name = await publish()
            const first = await platform.extensions.install(name)

            // Undeclare, then install again by the pinned ref — the shape of a
            // DIFFERENT profile installing what this machine already holds.
            await platform.extensions.uninstall(name)
            const second = await platform.extensions.install(first.ref)

            // Same directory, no refetch. One copy, many profiles.
            expect(second.root).toBe(first.root)
            expect(second.ref).toBe(first.ref)
        })
    }, 120_000)

    test("uninstalling something not installed changes nothing", async () => {
        await withProfile(async ({ platform }) => {
            expect(await platform.extensions.uninstall("@axon/never")).toEqual({ changed: false, removed: false })
        })
    }, 120_000)
})

/**
 * `declared` mirrors profile.config.ts, and must never lag it.
 *
 * It exists so a palette can render the list synchronously — `children()`
 * cannot await. That made it a CACHE of a file, and it was refreshed only on
 * load(), while install/update/uninstall all write the config and let the
 * watcher reload asynchronously. So for the whole window between the write and
 * that reload — exactly when the user is looking — the list was wrong.
 *
 * The symptom was a palette that could not undo itself: after installing,
 * `:ext uninstall` rendered "(none installed)" over a config that plainly
 * declared one, so there was no row to select and uninstall appeared broken.
 */
describe("extension declared: the cache tracks the file", () => {
    test("a fresh handle can read the list without loading anything", async () => {
        await withProfile(async ({ platform, publish }) => {
            const name = await publish()
            const { ref } = await platform.extensions.install(name)

            // syncDeclared() reads the config and runs NO extension code, which
            // is what makes it safe to call from a surface that only renders.
            await platform.extensions.syncDeclared()
            expect([...platform.extensions.declared]).toContain(ref)
        })
    }, 120_000)

    test("installing updates declared immediately — no load in between", async () => {
        await withProfile(async ({ platform, publish }) => {
            const name = await publish()
            const { ref } = await platform.extensions.install(name)

            // Nothing has loaded. The uninstall palette reads exactly this.
            expect([...platform.extensions.declared]).toContain(ref)
        })
    }, 120_000)

    test("uninstalling updates declared immediately", async () => {
        await withProfile(async ({ platform, publish }) => {
            const name = await publish()
            await platform.extensions.install(name)
            await platform.extensions.uninstall(name)

            expect([...platform.extensions.declared]).toEqual([])
            // And the cache agrees with the file, which is the real invariant.
            expect(await platform.extensions.list()).toEqual([])
        })
    }, 120_000)

    test("declared and the file never disagree after a write", async () => {
        await withProfile(async ({ platform, publish }) => {
            const name = await publish()

            // The invariant stated directly, checked after every write verb:
            // whatever a palette renders is whatever would load.
            await platform.extensions.install(name)
            expect([...platform.extensions.declared]).toEqual(await platform.extensions.list())

            await platform.extensions.uninstall(name)
            expect([...platform.extensions.declared]).toEqual(await platform.extensions.list())

            await platform.extensions.install(name)
            expect([...platform.extensions.declared]).toEqual(await platform.extensions.list())
        })
    }, 120_000)
})

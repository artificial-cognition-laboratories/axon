import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../setup/user"

/**
 * Updating an extension — asking what is published, and moving to it.
 *
 * ── The two halves are deliberately separate ────────────────────────────────
 *
 * An extension is arbitrary TypeScript that runs at module scope on every boot
 * with the full TUI API. So `updates()` only READS the registry and `update()`
 * is the privileged act that applies one — there is no path that does both,
 * and no automatic update to opt out of. These tests pin that split: the check
 * must not move anything, and the apply must re-pin the config so the change
 * survives a restart.
 *
 * Real artifacts against local staging, published twice to produce a genuine
 * version gap — a mocked registry would prove only that the mock returns what
 * it was told to.
 */

function disposableName(): string {
    return `@${TEST_USER.username}/test-upd-${crypto.randomUUID().slice(0, 8)}`
}

type Published = {
    name: string
    /**
     * Publish this same project again.
     *
     * The version it would publish is already taken, so `publish()` auto-bumps
     * the patch and retries — the real "I just shipped a fix" shape, and the
     * only way to produce a genuine version gap without mocking the registry.
     */
    republish: () => Promise<string>
}

type Fixture = {
    platform: ReturnType<typeof Platform>
    publish: () => Promise<Published>
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
                // Scaffolded ONCE and the handle kept: projects.create refuses
                // a directory that already exists, so a second publish has to
                // reuse this project rather than build another at the same path.
                const project = await platform.projects.create("extension", { name, dir: workDir })
                await project.publish()
                return {
                    name,
                    republish: async () => (await project.publish()).version,
                }
            },
        })
    } finally {
        await rm(storeDir, { recursive: true, force: true })
        await rm(workDir, { recursive: true, force: true })
    }
}

describe("extension updates: the check", () => {
    test("reports an installed extension as current when nothing newer exists", async () => {
        await withProfile(async ({ platform, publish }) => {
            const { name } = await publish()
            await platform.extensions.install(name)

            const [entry] = await platform.extensions.updates()

            expect(entry?.name).toBe(name)
            expect(entry?.outdated).toBe(false)
            expect(entry?.current).toBe(entry?.latest)
        })
    }, 120_000)

    test("reports it as outdated once a newer version is published", async () => {
        await withProfile(async ({ platform, publish }) => {
            const { name, republish } = await publish()
            await platform.extensions.install(name)
            const installed = (await platform.extensions.updates())[0]!

            // A second publish of the same name — the patch bump the registry
            // applies on a version collision.
            await republish()

            const [entry] = await platform.extensions.updates()

            expect(entry?.outdated).toBe(true)
            expect(entry?.current).toBe(installed.current)
            expect(entry?.latest).not.toBe(installed.current)
        })
    }, 120_000)

    test("checking does not move anything — the config still pins the old version", async () => {
        await withProfile(async ({ platform, publish }) => {
            const { name, republish } = await publish()
            const { ref } = await platform.extensions.install(name)
            await republish()

            await platform.extensions.updates()

            // The whole point of the read/apply split: knowing an update exists
            // must never be the same act as taking it.
            expect(await platform.extensions.list()).toContain(ref)
        })
    }, 120_000)
})

describe("extension updates: the apply", () => {
    test("moves to the named version and re-pins the config", async () => {
        await withProfile(async ({ platform, publish }) => {
            const { name, republish } = await publish()
            const { ref: before } = await platform.extensions.install(name)
            await republish()

            const [entry] = await platform.extensions.updates()
            const { ref: after } = await platform.extensions.update(name, entry!.latest!)

            expect(after).not.toBe(before)
            expect(after).toBe(`${name}@${entry!.latest}`)

            // ONE entry, at the new version. addEntry replaces a same-name
            // entry rather than appending — two would load the extension twice
            // and resolve every collision against whichever came first.
            const declared = await platform.extensions.list()
            expect(declared.filter(source => source.startsWith(name))).toEqual([after])
        })
    }, 120_000)

    test("the update is reported as current by the next check", async () => {
        await withProfile(async ({ platform, publish }) => {
            const { name, republish } = await publish()
            await platform.extensions.install(name)
            await republish()

            const [outdated] = await platform.extensions.updates()
            await platform.extensions.update(name, outdated!.latest!)

            const [entry] = await platform.extensions.updates()
            expect(entry?.outdated).toBe(false)
        })
    }, 120_000)
})

describe("extension updates: what is excluded", () => {
    test("a local path extension is never offered an update", async () => {
        await withProfile(async ({ platform }) => {
            const dir = await mkdtemp(join(tmpdir(), "axon-test-local-"))
            try {
                const local = await platform.projects.create("extension", {
                    name: "@local/scratch",
                    dir,
                })
                await platform.extensions.install(local.root)

                // A local path is the user's own source: no version, no
                // publisher, nothing to move to. Offering it would be offering
                // a row that cannot work.
                expect(await platform.extensions.updates()).toEqual([])
            } finally {
                await rm(dir, { recursive: true, force: true })
            }
        })
    }, 120_000)
})

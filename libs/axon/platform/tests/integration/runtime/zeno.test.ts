import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"

/**
 * Zeno — the default agent, guaranteed to exist.
 *
 * A first-run user has no agents and an agent is the only runnable thing, so
 * the platform guarantees exactly one: zeno, cloned from `@axon/zeno` in the
 * registry. These tests assert the GUARANTEE, not the mechanism — that zeno is
 * there, that it survives deletion, and that an existing one is never
 * clobbered. Cloning is how it arrives today; the contract holds regardless.
 *
 * The registry source matters for one reason worth stating: zeno is the face of
 * the product to a new user, and publishing a new `@axon/zeno` has to reach
 * every install without a CLI release. A local scaffold template would freeze
 * it at whatever version each user installed.
 */

function login(platform: ReturnType<typeof Platform>): void {
    platform.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })
}

async function withPlatform(run: (platform: ReturnType<typeof Platform>) => Promise<void>): Promise<void> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
    try {
        login(platform)
        await run(platform)
    } finally {
        await platform.agents.shutdown()
        await rm(storeDir, { recursive: true, force: true })
    }
}

describe("runtime.zeno", () => {
    it("is absent on a fresh profile and present after ensure()", async () => {
        await withPlatform(async platform => {
            expect(platform.agents.zeno.exists).toBe(false)

            const project = await platform.agents.zeno.ensure()

            expect(platform.agents.zeno.exists).toBe(true)
            expect(project.root).toBe(join(platform.store.profiles.active()!.agents.root, "zeno"))
        })
    }, 180_000)

    it("clones a prepared agent surface, not a bare directory", async () => {
        // The point of ensure() over a plain download: what lands has to be
        // bootable. A cloned tree with no node_modules and no compiled brain
        // would satisfy `exists` and fail on the user's first message.
        await withPlatform(async platform => {
            const project = await platform.agents.zeno.ensure()

            expect(existsSync(join(project.root, "package.json"))).toBe(true)
            expect(existsSync(join(project.root, "axon.config.ts"))).toBe(true)
            expect(existsSync(join(project.root, "node_modules"))).toBe(true)
        })
    }, 180_000)

    it("ships its modules installed, not merely declared", async () => {
        // Named in a config is not present on disk. These have to resolve on
        // zeno's first boot, which is before anything would install them.
        await withPlatform(async platform => {
            const project = await platform.agents.zeno.ensure()

            expect(existsSync(join(project.root, "node_modules", "@axon", "fs"))).toBe(true)
            expect(existsSync(join(project.root, "node_modules", "@axon", "subagent"))).toBe(true)
        })
    }, 180_000)

    it("is idempotent — a second ensure() opens the existing zeno untouched", async () => {
        // Zeno is the user's to edit once it exists. A re-clone on every boot
        // is exactly the clobbering that made the managed `base` workspace
        // need an ownership hash to defend against itself.
        await withPlatform(async platform => {
            const first = await platform.agents.zeno.ensure()
            const marker = join(first.root, "USER_EDIT.md")
            await Bun.write(marker, "the user's own file")

            const second = await platform.agents.zeno.ensure()

            expect(second.root).toBe(first.root)
            expect(existsSync(marker)).toBe(true)
        })
    }, 180_000)

    it("comes back after deletion — the guarantee is availability, not a lock", async () => {
        // "Cannot be deleted" is not enforcement. The user may remove the
        // directory; the next ensure() puts one back, so the TUI always has
        // somewhere to send a first message.
        await withPlatform(async platform => {
            const first = await platform.agents.zeno.ensure()
            await rm(first.root, { recursive: true, force: true })
            expect(platform.agents.zeno.exists).toBe(false)

            const restored = await platform.agents.zeno.ensure()

            expect(platform.agents.zeno.exists).toBe(true)
            expect(restored.root).toBe(first.root)
        })
    }, 180_000)

    it("repairs a mangled zeno — a directory that cannot open is replaced, not returned", async () => {
        // The failure this exists for: deleting axon.config.ts (or any partial
        // clone that never finished) leaves a directory that EXISTS but is not
        // a project. A bare existsSync() check called that healthy, skipped the
        // re-clone, and handed the caller a root that projects.open() then
        // refused — surfacing as PROJECT_NOT_FOUND on the user's first boot,
        // with no way out. Availability has to survive a broken zeno, not just
        // a missing one.
        await withPlatform(async platform => {
            const first = await platform.agents.zeno.ensure()
            await rm(join(first.root, "axon.config.ts"), { force: true })

            // The directory is still there; it just isn't an agent any more.
            expect(existsSync(first.root)).toBe(true)
            expect(platform.agents.zeno.exists).toBe(false)

            const repaired = await platform.agents.zeno.ensure()

            expect(platform.agents.zeno.exists).toBe(true)
            expect(repaired.root).toBe(first.root)
            expect(existsSync(join(repaired.root, "axon.config.ts"))).toBe(true)
        })
    }, 180_000)

    it("reports a name that resolves — the directory, not the scoped package name", async () => {
        // zeno is CLONED FROM THE REGISTRY, so its package.json name is
        // "@axon/zeno". Feeding that back to a resolver reads it as a path (it
        // contains a "/") and resolves it against cwd, which is what made the
        // TUI's first boot fail with PROJECT_NOT_FOUND on a directory that
        // never existed. Whatever a caller boots zeno by must not be scoped.
        await withPlatform(async platform => {
            const project = await platform.agents.zeno.ensure()

            expect(platform.agents.zeno.name).toBe("zeno")
            expect(basename(project.root)).toBe("zeno")
        })
    }, 180_000)

    it("throws NOT_AUTHENTICATED when no profile is active", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            // No login() — zeno lives under the active profile, so without one
            // there is no directory to answer about.
            expect(() => platform.agents.zeno.exists).toThrow()
            await expect(platform.agents.zeno.ensure()).rejects.toThrow()
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 30_000)
})

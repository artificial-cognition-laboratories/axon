import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_FRAMEWORK_PUBLISHED } from "../../../../setup/user"
import { describe, it, expect } from "bun:test"

/**
 * A cognet is pinned exactly, never left as a range for bun to resolve.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * The npm protocol has no concept of a kernel ABI — deliberately, it is what
 * makes a cognet installable by `bun add` at all. So ANY range left for bun to
 * resolve is a range resolved without the ABI.
 *
 * `installer.install()` already asks the registry the right question
 * (`/api/registry/resolve?abi=N` → "the newest version that fits") and used to
 * throw the answer away, writing `^version` or re-using the declared range. A
 * cloned `@cody/io` declaring `@cody/io-engine: ^0.1.0` therefore let bun pick
 * between an ABI-10 and an ABI-11 build, and it picked wrong — failing at
 * prepare, naming a version pin nobody in that session had chosen.
 *
 * A range is a SEMVER compatibility claim, and an ABI-bound artifact is not
 * semver-compatible in the way a range implies. That is the entire reason `abi`
 * exists as a separate axis from the version.
 *
 * ── Why these run against a real registry ───────────────────────────────────
 *
 * The behaviour under test is what gets WRITTEN after a resolve, and the resolve
 * is a registry call. A stub would assert the shape of code that was already
 * shaped correctly — the resolve was always right, it was the write that lost
 * the answer.
 */

function disposableName(prefix: string): string {
    return `@${TEST_USER.username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

async function authenticatedPlatform(storeDir: string) {
    const seed = Platform({ ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
    seed.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })
    return Platform({ ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
}

/** The agent's declared dependency on its cognet, straight from package.json. */
async function declaredCognet(root: string): Promise<string | undefined> {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as {
        dependencies?: Record<string, string>
    }
    const entries = Object.entries(pkg.dependencies ?? {})
    return entries.find(([name]) => name.startsWith("@axon/"))?.[1]
}

/**
 * Declare the cognet EXPLICITLY, the way a real agent does.
 *
 * Load-bearing for the short-circuit test below and worth stating why: an agent
 * with no `cognet:` line falls back to DEFAULT_COGNET, and prepare installs that
 * with `track: "latest"` — which bypasses the already-installed branch entirely.
 * A test on an undeclared cognet therefore passes whether or not the guard
 * exists, which is how the first version of this file gave a false green.
 * `@cody/io` declares its cognet; that is the path that broke.
 */
async function declareCognet(root: string, specifier: string): Promise<void> {
    const path = join(root, "axon.config.ts")
    const config = await readFile(path, "utf-8")
    if (config.includes("cognet:")) return
    await writeFile(path, config.replace("defineAgent({", `defineAgent({\n    cognet: "${specifier}",`))
}

/** Rewrite the cognet's declaration — how a published artifact arrives. */
async function redeclareCognetAs(root: string, range: string): Promise<string> {
    const path = join(root, "package.json")
    const pkg = JSON.parse(await readFile(path, "utf-8")) as { dependencies?: Record<string, string> }
    const name = Object.keys(pkg.dependencies ?? {}).find(key => key.startsWith("@axon/"))!
    pkg.dependencies![name] = range
    await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`)
    return name
}

describe("cognet installs are pinned, not ranged", () => {
    it("records an EXACT version after an ABI-aware resolve", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            await agent.prepare()

            const declared = await declaredCognet(agent.root)
            expect(declared).toBeDefined()
            // No operator at all. `^` or `~` here hands the choice back to bun,
            // which cannot see an ABI — that is the whole defect.
            expect(declared).toMatch(/^\d+\.\d+\.\d+/)
            expect(declared!.startsWith("^")).toBe(false)
            expect(declared!.startsWith("~")).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    })

    /**
     * The regression, exactly as it arrived.
     *
     * A published agent declares a RANGE. On the clone, `already-installed`
     * compared that range against itself, matched, and returned early — so the
     * ABI-aware resolve never ran and whatever bun had installed stood. That is
     * a different question from the one being asked: the range says what the
     * author allowed, not whether what is on disk fits THIS kernel.
     */
    it("re-resolves a declared RANGE instead of reporting already-installed", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            await declareCognet(agent.root, "@axon/zero")
            await agent.prepare()

            const pinned = await declaredCognet(agent.root)
            expect(pinned).toBeDefined()

            /*
             * Put the manifest back into the shape a PUBLISHED artifact has.
             *
             * Built from the bare version rather than from whatever the first
             * prepare wrote, so this test measures the short-circuit and not
             * the pinning. Deriving the range from `pinned` made it pass
             * spuriously when pinning regressed: `^` + an already-`^` value
             * produced a range that resolved back to the same string.
             */
            const bare = pinned!.replace(/^[\^~]/, "")
            const range = `^${bare}`
            await redeclareCognetAs(agent.root, range)
            expect(await declaredCognet(agent.root)).toBe(range)

            await agent.prepare()

            // Re-resolved and re-pinned — not left as the range it was handed.
            const after = await declaredCognet(agent.root)
            expect(after).not.toBe(range)
            expect(after).toMatch(/^\d+\.\d+\.\d+/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    })

    /**
     * Pinning must be STABLE. A pin that re-resolved to something new on every
     * prepare would be its own bug — the agent that runs would stop being the
     * agent that was prepared.
     */
    it("is idempotent — preparing twice does not move the pin", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })

            await agent.prepare()
            const first = await declaredCognet(agent.root)
            await agent.prepare()

            expect(await declaredCognet(agent.root)).toBe(first)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    })
})

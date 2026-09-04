import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

/**
 * Recovery — a broken project must repair itself through the REAL pipeline.
 *
 * THE GAP THESE EXIST TO CLOSE. Every repair in this system has a unit test,
 * and every one of those tests passed while the failure it describes was live
 * in production. `track-latest.test.ts` even has a case named "replaces a
 * declared range that no longer resolves, rather than failing forever" — it
 * passed, and that exact failure still shipped.
 *
 * The reason is ORDERING. Unit tests call the repair directly; production runs
 * a pipeline, and the pipeline hit `bun install` first. Bun resolves the WHOLE
 * manifest at once, so one unresolvable range failed every package with it,
 * dying long before the repair that would have fixed it ever ran.
 *
 * So these tests do the one thing the unit tests structurally cannot: break a
 * project the way it actually broke, run `prepare()` — the real entry point, in
 * its real order — and assert it comes back. A repair that only works when
 * called directly is not a repair.
 */

function disposableName(prefix: string): string {
    return `@${TEST_USER.username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

async function authenticatedPlatform(storeDir: string) {
    const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
    seed.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })
    return Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
}

type Pkg = {
    dependencies?: Record<string, string>
    axon?: { trackedFrom?: Record<string, string> }
} & Record<string, unknown>

async function readPkg(root: string): Promise<Pkg> {
    return JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as Pkg
}

async function writePkg(root: string, pkg: Pkg): Promise<void> {
    await writeFile(join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8")
}

/** A scaffolded, prepared agent with a real module installed. */
async function preparedAgent() {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
    const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

    const platform = await authenticatedPlatform(storeDir)
    const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
    await module_.publish()

    const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
    await agent.modules.install([module_.name])
    await agent.prepare()

    return {
        agent,
        moduleName: module_.name,
        cleanup: () => Promise.all([
            rm(storeDir, { recursive: true, force: true }),
            rm(moduleDir, { recursive: true, force: true }),
            rm(agentDir, { recursive: true, force: true }),
        ]),
    }
}

describe("prepare recovers a project broken in production", () => {
    it("re-resolves a range auto-written against a DIFFERENT registry", async () => {
        // THE INCIDENT, exactly: `track: "latest"` resolved against local
        // staging, wrote a version into the manifest that production had never
        // published, and every install after that failed to resolve. The unit
        // test for this passed the whole time — it called the repair directly,
        // while the pipeline died in bun install first.
        const p = await preparedAgent()
        try {
            const pkg = await readPkg(p.agent.root)
            await writePkg(p.agent.root, {
                ...pkg,
                dependencies: { ...pkg.dependencies, [p.moduleName]: "^99.0.0" },
                axon: { trackedFrom: { [p.moduleName]: "http://127.0.0.1:65535" } },
            })

            await p.agent.prepare()

            const after = await readPkg(p.agent.root)
            // Re-resolved to something that exists HERE, and re-stamped to the
            // registry that answered — not left at the impossible version.
            expect(after.dependencies?.[p.moduleName]).not.toBe("^99.0.0")
            expect(after.axon?.trackedFrom?.[p.moduleName]).not.toBe("http://127.0.0.1:65535")
        } finally {
            await p.cleanup()
        }
    }, 180_000)

    it("rebuilds a node_modules of dangling links after its cache tree is evicted", async () => {
        // THE INCIDENT: node_modules is entirely symlinks into a machine-wide
        // tree cache, and LRU eviction deleted the tree while this project
        // still pointed at it. Every package went dangling at once and the
        // agent reported a missing cognet — sending the user to look for a typo
        // in a config that was correct.
        const p = await preparedAgent()
        try {
            const modules = join(p.agent.root, "node_modules")
            const gone = join(tmpdir(), "axon-evicted-tree-does-not-exist")

            // Replace the whole tree with links into nowhere — the exact shape
            // an evicted graft leaves behind.
            const entries = (await readdir(modules)).filter(name => !name.startsWith("."))
            await rm(modules, { recursive: true, force: true })
            await mkdir(modules, { recursive: true })
            for (const entry of entries) await symlink(join(gone, entry), join(modules, entry))

            await p.agent.prepare()

            // Resolvable again, and through a link that points somewhere real.
            expect(existsSync(join(modules, ...p.moduleName.split("/")))).toBe(true)
        } finally {
            await p.cleanup()
        }
    }, 180_000)

    it("reinstalls a package deleted from under a manifest that still declares it", async () => {
        // "Declared" is not "installed". This short-circuited the install
        // entirely once, producing an error that told the user to run the
        // command that had just skipped the work.
        const p = await preparedAgent()
        try {
            await rm(join(p.agent.root, "node_modules", ...p.moduleName.split("/")), {
                recursive: true,
                force: true,
            })

            await p.agent.prepare()

            expect(existsSync(join(p.agent.root, "node_modules", ...p.moduleName.split("/")))).toBe(true)
        } finally {
            await p.cleanup()
        }
    }, 180_000)

    it("is idempotent — a healthy project prepares twice with the same result", async () => {
        // The other half of recovery: repairs must not fire on a project that
        // is already correct. A self-healing pipeline that rewrites a healthy
        // manifest is churn, and churn is how a range drifts in the first place.
        const p = await preparedAgent()
        try {
            const before = await readPkg(p.agent.root)
            await p.agent.prepare()
            const after = await readPkg(p.agent.root)

            expect(after.dependencies).toEqual(before.dependencies!)
            expect(after.axon?.trackedFrom).toEqual(before.axon?.trackedFrom as Record<string, string>)
        } finally {
            await p.cleanup()
        }
    }, 180_000)
})

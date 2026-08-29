import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../../setup/user"

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

async function declaredRange(agentRoot: string, name: string): Promise<string | undefined> {
    const pkg = JSON.parse(await readFile(join(agentRoot, "package.json"), "utf-8")) as {
        dependencies?: Record<string, string>
    }
    return pkg.dependencies?.[name]
}

/**
 * `track: "latest"` is how a dependency the user never chose stays current.
 *
 * The default cognet is the only thing that uses it: an agent that names no
 * cognet gets @axon/zero, and a brain nobody selected should not silently
 * freeze at whatever version happened to be current when it was scaffolded.
 * Anything the user DID name — with or without a version — is a pin and must
 * survive untouched.
 */
describe("installer: track latest", () => {
    it("re-resolves and rewrites a declared range instead of honouring it as a pin", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            await agent.modules.install([module_.name], { declare: false, track: "latest" })
            expect(await declaredRange(agent.root, module_.name)).toBe("^0.1.0")

            // Publish a newer version, then install again with no constraint.
            // Without track, the declared ^0.1.0 would be treated as a pin and
            // the new version would never land.
            const pkgPath = join(module_.root, "package.json")
            const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as Record<string, unknown>
            await writeFile(pkgPath, JSON.stringify({ ...pkg, version: "0.2.0" }, null, 2) + "\n")
            await (await platform.projects.open(module_.root)).publish()

            const tracked = await agent.modules.install([module_.name], { declare: false, track: "latest" })

            expect(tracked[0]?.status).toBe("installed")
            expect(tracked[0]?.version).toBe("0.2.0")
            expect(await declaredRange(agent.root, module_.name)).toBe("^0.2.0")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 60_000)

    it("without track, a declared range is left alone — an explicit choice stays pinned", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            await agent.modules.install([module_.name], { declare: false })

            const pkgPath = join(module_.root, "package.json")
            const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as Record<string, unknown>
            await writeFile(pkgPath, JSON.stringify({ ...pkg, version: "0.2.0" }, null, 2) + "\n")
            await (await platform.projects.open(module_.root)).publish()

            const pinned = await agent.modules.install([module_.name], { declare: false })

            expect(pinned[0]?.status).toBe("already-installed")
            expect(await declaredRange(agent.root, module_.name)).toBe("^0.1.0")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 60_000)

    it("replaces a declared range that no longer resolves, rather than failing forever", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            await agent.modules.install([module_.name], { declare: false, track: "latest" })

            // Exactly what happened in production: a workspace sibling's version
            // (a FRAMEWORK version, on a registry artifact) got written into the
            // agent's manifest as ^2.0.100. It resolves nowhere but that machine,
            // and because the installer honoured it as a pin, every prepare
            // re-asserted it — surfacing to the user as a failed boot.
            const pkgPath = join(agent.root, "package.json")
            const agentPkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
                dependencies?: Record<string, string>
            } & Record<string, unknown>
            await writeFile(
                pkgPath,
                JSON.stringify(
                    { ...agentPkg, dependencies: { ...agentPkg.dependencies, [module_.name]: "^2.0.100" } },
                    null,
                    2,
                ) + "\n",
            )

            const healed = await agent.modules.install([module_.name], { declare: false, track: "latest" })

            expect(healed[0]?.status).toBe("installed")
            expect(await declaredRange(agent.root, module_.name)).toBe("^0.1.0")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 60_000)
})

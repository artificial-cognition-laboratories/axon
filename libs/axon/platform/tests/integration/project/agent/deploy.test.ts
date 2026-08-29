import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../setup/user"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

/** A Platform() whose store already has TEST_USER's real API key persisted — Cloud() picks it up at construction. */
async function authenticatedPlatform(storeDir: string) {
    const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
    seed.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })

    return Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
}

describe("agent project: deploy()", () => {
    it("bundles this project and deploys it as a real, reachable agent", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("agent", { name, dir })

            const result = await project.deploy()

            try {
                expect(result.name).toBe(name)
                expect(typeof result.registeredId).toBe("string")
                expect(result.url.startsWith("http://localhost:")).toBe(true)

                // The RUNTIME's own health endpoint, not a scaffolded route.
                // A scaffold is deliberately minimal (config + boot), so
                // asserting against an example route tested the template
                // rather than the deployment — and broke the day that route
                // stopped being written. /_axon/health is served by every
                // agent that is running at all, which is the claim here.
                const response = await fetch(`${result.url}/_axon/health`)
                expect(response.ok).toBe(true)
            } finally {
                await result.deployment.delete()
            }
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("propagates onProgress steps through to the caller", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()
        const steps: string[] = []

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("agent", { name, dir })

            const result = await project.deploy({ onProgress: step => steps.push(step.step) })

            try {
                expect(steps).toEqual(["publishing", "provisioning", "starting", "ready"])
            } finally {
                await result.deployment.delete()
            }
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("auto-bumps an already-published version before provisioning", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("agent", { name, dir })
            await project.publish()

            const result = await project.deploy()
            try {
                const pkg = JSON.parse(await Bun.file(join(project.root, "package.json")).text())
                const versions = await platform.cloud.client.registry.agents
                    .agent(result.registeredId)
                    .versions()
                expect(pkg.version).toBe("0.1.1")
                expect(versions.some(version => version.version === "0.1.1")).toBe(true)
            } finally {
                await result.deployment.delete()
            }
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)
})

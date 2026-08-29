import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { ask } from "../../setup/agent"

/**
 * The resumable conversations on disk.
 *
 * The filesystem is the source of truth for "a session exists" — there is no
 * registry to keep in sync, so this scans <agent>/data/sessions/*.jsonl
 * directly. A session record outlives the runtime that wrote it, which is the
 * whole point: the @ palette lists conversations you can come back to.
 */

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

function login(platform: ReturnType<typeof Platform>): void {
    platform.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })
}

/** Create a named agent under the ACTIVE profile — sessions() only scans there. */
async function profileAgent(platform: ReturnType<typeof Platform>, name: string) {
    const agentsRoot = platform.store.profiles.active()!.agents.root
    const project = await platform.projects.create("agent", { name, dir: agentsRoot })
    await writeFile(join(project.root, "axon.config.ts"), "export default defineAgent({ engine: Mock() })\n")
    return project
}

describe("runtime.sessions", () => {
    it("is empty when no profile is active — never throws", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            expect(platform.agents.sessions()).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("lists a session written by a spawned agent, attributed to its agent", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        const name = disposableName()
        try {
            login(platform)
            const project = await profileAgent(platform, name)
            const instance = await platform.agents.spawn(project)

            const records = platform.agents.sessions()
            const record = records.find(item => item.sessionId === instance.sessionId)

            expect(record).toBeDefined()
            expect(record!.agent).toBe(name)
            expect(record!.filePath).toContain(join("data", "sessions"))
            expect(record!.running).toBe(true)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 60_000)

    it("keeps the record after shutdown, with running false — a session outlives its runtime", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            login(platform)
            const project = await profileAgent(platform, disposableName())
            const instance = await platform.agents.spawn(project)
            await platform.agents.stop(instance.sessionId)

            const record = platform.agents.sessions().find(item => item.sessionId === instance.sessionId)

            expect(record).toBeDefined()
            expect(record!.running).toBe(false)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 60_000)

    it("orders newest first across several agents", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            login(platform)
            const first = await profileAgent(platform, disposableName())
            await platform.agents.spawn(first)

            // Distinct mtimes — the ordering claim is about modifiedAt, and two
            // writes inside one millisecond would make the assertion vacuous.
            await Bun.sleep(1_100)

            const second = await profileAgent(platform, disposableName())
            const newer = await platform.agents.spawn(second)

            const records = platform.agents.sessions()
            expect(records.length).toBeGreaterThanOrEqual(2)
            expect(records[0]!.sessionId).toBe(newer.sessionId)
            expect(records[0]!.modifiedAt).toBeGreaterThanOrEqual(records[1]!.modifiedAt)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 90_000)

    it("reports hasEntries only once the log holds a real timeline entry", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            login(platform)
            const project = await profileAgent(platform, disposableName())
            const instance = await platform.agents.spawn(project)

            const fresh = platform.agents.sessions().find(item => item.sessionId === instance.sessionId)!
            expect(fresh.hasEntries).toBe(false)

            await ask(platform.agents.current!, "say something")

            const used = platform.agents.sessions().find(item => item.sessionId === instance.sessionId)!
            expect(used.hasEntries).toBe(true)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 90_000)
})

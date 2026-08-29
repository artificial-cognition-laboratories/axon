import { rmSync } from "node:fs"
import { join } from "node:path"
import { prepare, socketRoot, type SpawnedAgent } from "../../../src/spawn"
import type { SupervisorServices } from "../../../src/supervisor"

/**
 * The full boundary, with a REAL child process.
 *
 * Everything below this file is testable in one process; this is the part that
 * is not — the env carrier reaching a child, the child dialling by path
 * (`Bun.spawn` exposes stdio only, so it cannot inherit a connected fd), and
 * both directions of the contract working across an actual process boundary.
 *
 * The agent fixture stands in for `Axon()`. What is asserted is the LINK, not
 * cognition.
 */
const FIXTURE = join(import.meta.dir, "fixtures", "agent.ts")
/** Where the platform keeps the program a box execs — see agentEntrypoints(). */
const PLATFORM_LINK_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "platform", "src", "link")

describe("spawn — a real agent process over the link", () => {
    const sessionId = `test-${process.pid}-${Date.now()}`
    let agent: SpawnedAgent | null = null
    let child: ReturnType<typeof Bun.spawn> | null = null
    const errors: Error[] = []
    const committed: Array<{ type: string; data: unknown }> = []

    afterEach(() => {
        child?.kill()
        agent?.dispose()
        agent = null
        child = null
        rmSync(socketRoot(sessionId), { recursive: true, force: true })
        errors.length = 0
        committed.length = 0
    })

    async function boot(services: Partial<SupervisorServices> = {}, env: Record<string, string> = {}) {
        const full: SupervisorServices = {
            async *infer() {},
            commit: (type, data) => { committed.push({ type: type as string, data }) },
            ...services,
        }

        // Listeners armed BEFORE the child exists: a child that dials before
        // anyone is listening gets ECONNREFUSED and dies at startup.
        const prepared = prepare({ sessionId, services: full, onError: e => errors.push(e) })

        child = Bun.spawn(["bun", "run", FIXTURE], {
            env: { ...process.env, ...prepared.env, ...env },
            stdout: "pipe",
            stderr: "pipe",
        })

        agent = await prepared.connected
        return agent
    }

    it("connects a spawned child to its supervisor", async () => {
        const spawned = await boot()
        expect(spawned.channels.control.isClosed).toBe(false)
        expect(spawned.channels.data.isClosed).toBe(false)
    })

    it("delivers a stimulus into the child and gets its admission", async () => {
        const spawned = await boot()
        expect(await spawned.link.stimulus({ data: { content: "hello" } } as never)).toEqual({ admitted: true })

        await new Promise(r => setTimeout(r, 100))
        expect(committed.map(c => (c.data as { message: string }).message)).toContain("heard:hello")
    })

    it("carries a REFUSAL back across the process boundary", async () => {
        // The mind declining is a verdict, and it has to survive the wire as
        // one rather than surfacing as a transport failure.
        const spawned = await boot()
        expect(await spawned.link.stimulus({ data: { content: "busy" } } as never)).toEqual({ admitted: false })
    })

    it("lets the child stream inference without ever holding a credential", async () => {
        // The whole reason the boundary exists: the agent can CAUSE inference
        // and can never obtain the key that performs it.
        await boot({
            async *infer() {
                yield { type: "text:delta", content: "he" } as never
                yield { type: "text:delta", content: "llo" } as never
            },
        }, { AXON_TEST_INFER: "1" })

        await new Promise(r => setTimeout(r, 400))
        expect(committed.map(c => (c.data as { message: string }).message)).toContain("inferred:hello")
    })

    it("lands an interrupt on the control channel", async () => {
        const spawned = await boot()
        spawned.link.interrupt("user")
        await new Promise(r => setTimeout(r, 120))
        expect(committed.map(c => (c.data as { message: string }).message)).toContain("interrupt:user")
    })

    it("hot-reloads through update", async () => {
        const spawned = await boot()
        await spawned.link.update({} as never)
        await new Promise(r => setTimeout(r, 100))
        expect(committed.map(c => (c.data as { message: string }).message)).toContain("updated")
    })

    it("shuts the child down through the link", async () => {
        const spawned = await boot()
        await spawned.link.shutdown()
        await new Promise(r => setTimeout(r, 200))
        expect(committed.map(c => (c.data as { message: string }).message)).toContain("shutdown")
    })

    it("evaluates code in the child and returns the value", async () => {
        // The devtools console. On CONTROL, so it never queues behind a token
        // stream — a human waiting at a prompt must not feel the agent hang.
        const spawned = await boot()
        const result = await spawned.link.run("1 + 1")
        expect((result as { value: string }).value).toBe("ran:1 + 1")
    })

    it("serves the whole prompt surface through one verb", async () => {
        const spawned = await boot()
        expect(await spawned.link.prompts({ action: "list" })).toMatchObject({ served: "list" })
        expect(await spawned.link.prompts({ action: "get", name: "greeting" }))
            .toMatchObject({ served: "get", name: "greeting" })
    })

    it("removes the socket directory on dispose", async () => {
        const spawned = await boot()
        const root = spawned.root
        spawned.dispose()
        agent = null
        expect(() => rmSync(join(root, "control.sock"))).toThrow()
    })

    it("survives a stale socket directory from a crashed predecessor", async () => {
        // A process killed with -9 leaves paths that `listen` refuses
        // (EADDRINUSE) even with nothing behind them.
        await boot()
        agent!.channels.close()
        child!.kill()
        await new Promise(r => setTimeout(r, 100))

        const second = await boot()
        expect(second.channels.control.isClosed).toBe(false)
    })
})

describe("spawn — a boot failure reports its own cause", () => {
    /**
     * The agent connects BEFORE it boots, so that a boot failure is reportable
     * at all. These pin both halves of that: the agent commits its diagnosis
     * through the link, and the supervisor waits long enough to hear it.
     *
     * Without both, a broken agent surfaced as LINK_PEER_CLOSED — "the agent
     * disconnected" — while the actual cause (a missing cognet, a tool that
     * would not compile) died with the process that knew it.
     */
    it("surfaces the agent's own error, not a closed socket", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
        const { tmpdir } = await import("node:os")
        const dir = mkdtempSync(join(tmpdir(), "axon-bootfail-"))
        const root = join(dir, "agent")
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", type: "module" }))

        const { spawnConfined, agentEntrypoints, agentEntrypoint } = await import("../../../src/index")

        // A blueprint with no cognet — an agent cannot run without a brain.
        const boot = spawnConfined({
            sessionId: `bootfail-${Date.now()}`,
            blueprint: { paths: { root }, tools: [] } as never,
            policy: { process: { spawn: true, run: true }, isolation: "none" } as never,
            services: { async *infer() {}, commit: () => {} },
            // The platform owns agent-main.ts — see agentEntrypoints(). A test in
            // the transport package has to name that directory itself.
            entrypoint: agentEntrypoint(agentEntrypoints(PLATFORM_LINK_DIR)),
            onError: () => {},
        })

        await expect(boot).rejects.toThrow(/cognet/i)
    }, 30_000)
})

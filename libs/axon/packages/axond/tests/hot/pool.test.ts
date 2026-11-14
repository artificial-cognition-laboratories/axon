import { describe, expect, test } from "bun:test"
import { Pool } from "../../src/labs/pool/index"
import type { BodyHandle, EndpointT } from "../../src/labs/body/index"
import type { BodyInfo, BodyState, RunningWorld } from "../../src/labs/types"

const WORLD: RunningWorld = {
    name: "Axon_Town", path: "/tmp/axon-town", state: "running",
    host: "127.0.0.1", port: 25565, password: "", players: [], observers: [],
    pid: 1, startedAt: new Date().toISOString(),
}

/** A body that boots instantly and records what the pool asked of it. */
function fake(input: { id: string; slot: number }) {
    let state: BodyState = "booting"
    let resting = false
    const body = {
        get resting() { return resting },
        rest() { resting = true },
        wake() { resting = false },
        get id() { return input.id },
        get state() { return state },
        get bridge() { return `ws://127.0.0.1:${52_500 + input.slot}/bridge` },
        get screen() { return `/dev/shm/axon-display-${100 + input.slot}/Xvfb_screen0` },
        get audio() { return `/tmp/${input.id}/hearing` },
        get hearing() { return { sampleRate: 22_050, channels: 2 } },
        info(lease: { id: string; agent: string } | null, world: string | null): BodyInfo {
            return {
                id: input.id, world: world, state: state, model: null, bridge: body.bridge,
                client: { display: `:${100 + input.slot}`, screen: body.screen, audio: body.audio, resting: resting },
                identity: null, lease: lease?.id ?? null, agent: lease?.agent ?? null,
                error: null, pids: [], startedAt: new Date().toISOString(),
            }
        },
        async boot() { state = "ready" },
        async join() {
            if (resting) throw new Error("joined while frozen")
            state = "embodied"
        },
        async leave() { state = "ready" },
        async prune() {},
        async stop() { state = "stopped" },
        /** What the game does to a body put out of the world: see `Body`. */
        fail() { state = "failed" },
    } satisfies BodyHandle & { fail(): void }
    return body
}

/** Where a leased body would speak the contract: opened and closed, nothing behind it. */
function endpoint(): EndpointT {
    return {
        async open() { return { url: "ws://127.0.0.1:1/body", token: "token" } },
        manifest() { return null },
        async close() {},
    }
}

/** Let the pool's own promises settle; nothing here waits on real time. */
const settle = () => Bun.sleep(30)

describe("body pool", () => {
    test("keeps the engine's number of spares warm, not a shared default", async () => {
        const made: string[] = []
        const pool = Pool({ endpoint: endpoint,
            world: () => WORLD,
            start: async () => WORLD,
            body: input => { made.push(input.id); return fake(input) },
            limits: { spares: 2, max: 4 },
        })

        pool.start()
        await settle()

        expect(made).toHaveLength(2)
    })

    test("never commits more bodies than the engine allows", async () => {
        const pool = Pool({ endpoint: endpoint, world: () => WORLD, start: async () => WORLD, body: fake, limits: { spares: 1, max: 2 } })
        pool.start()
        await settle()

        pool.add()
        await settle()
        expect(() => pool.add()).toThrow(/limit of 2 bodies/)
    })

    /**
     * The regression this file exists for.
     *
     * Booting a spare on top of a body that had just entered the world starved
     * the in-world client past the server's 30s keepalive and it was dropped
     * with "Timed out" — twice, at exactly 45s, with every process healthy.
     */
    test("does not boot a spare while a body is still settling into the world", async () => {
        const made: string[] = []
        const pool = Pool({ endpoint: endpoint,
            world: () => WORLD,
            start: async () => WORLD,
            body: input => { made.push(input.id); return fake(input) },
            limits: { spares: 1, max: 4, settleMs: 60_000 },
        })

        pool.start()
        await settle()
        expect(made).toHaveLength(1)

        await pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" })
        await settle()

        // The leased body is embodied and inside its settling window, so the
        // spare that would normally replace it is deliberately not booted.
        expect(made).toHaveLength(1)
        expect(pool.list().map(body => body.state)).toEqual(["embodied"])
    })

    test("boots the spare once the settling window has passed", async () => {
        const made: string[] = []
        const pool = Pool({ endpoint: endpoint,
            world: () => WORLD,
            start: async () => WORLD,
            body: input => { made.push(input.id); return fake(input) },
            limits: { spares: 1, max: 4, settleMs: 1 },
        })

        pool.start()
        await settle()
        await pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" })
        await Bun.sleep(20)
        await pool.lease({ agent: "other", pid: process.pid, identity: "Other", stateDir: "/tmp/other" }).catch(() => {})
        await settle()

        expect(made.length).toBeGreaterThan(1)
    })

    test("refuses to lease one identity into two bodies at once", async () => {
        const pool = Pool({ endpoint: endpoint, world: () => WORLD, start: async () => WORLD, body: fake, limits: { spares: 2, max: 4 } })
        pool.start()
        await settle()

        await pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" })
        await expect(
            pool.lease({ agent: "twin", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" }),
        ).rejects.toThrow(/Steve/)
    })

    test("leasing without a running world fails loudly", async () => {
        const pool = Pool({ endpoint: endpoint, world: () => null, start: async () => { throw new Error("no world") }, body: fake })

        await expect(
            pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" }),
        ).rejects.toThrow()
    })

    test("freezes a warm body nobody is in, and wakes it for the next agent", async () => {
        // A warm body used to render and capture at full speed with nobody
        // inside — the GPU busy for an empty room after the agent had gone.
        const pool = Pool({ endpoint: endpoint, world: () => WORLD, start: async () => WORLD, body: fake, limits: { spares: 1, max: 2, settleMs: 0 } })
        pool.start()
        await settle()
        expect(pool.list().map(body => body.client?.resting)).toEqual([true])

        const held = await pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" })
        expect(pool.list().find(body => body.id === held.body)!.client?.resting).toBe(false)

        await pool.release(held.lease)
        expect(pool.list().find(body => body.id === held.body)!.client?.resting).toBe(true)
    })

    /**
     * A body was taken from a running agent with nothing anywhere saying why:
     * the agent went on seeing a title screen, and the pool had no record.
     */
    test("says why every lease ended", async () => {
        const made: Array<ReturnType<typeof fake>> = []
        const pool = Pool({ endpoint: endpoint, world: () => WORLD, start: async () => WORLD, body: input => { const body = fake(input); made.push(body); return body }, limits: { spares: 2, max: 4 }, sweepMs: 10 })
        pool.start()
        await settle()

        const handed = await pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" })
        await pool.release(handed.lease)
        expect(pool.notices().at(-1)!.text).toBe(`${handed.body} released from steve (Steve): its agent handed it back`)

        const thrown = await pool.lease({ agent: "alex", pid: process.pid, identity: "Alex", stateDir: "/tmp/alex" })
        made.find(body => body.id === thrown.body)!.fail()
        await settle()
        expect(pool.leases()).toEqual([])
        expect(pool.notices().at(-1)!.text).toStartWith(`${thrown.body} failed under alex (Alex)`)
        pool.stop()
    })
})

/**
 * What an agent's world address does at the lease — the half of it the pool
 * owns. A lab that serves one world at a time still has to answer "be in
 * THIS world", and the answers that matter are: start it, join the one
 * already up, and never silently put the agent somewhere else.
 */
describe("the world an address names", () => {
    test("names a world, and the lab is asked to serve it", async () => {
        const asked: string[] = []
        // As a real lab behaves: nothing is running until it is started, and
        // once it is, the lab's own `world()` sees it.
        let live: RunningWorld | null = null
        const pool = Pool({
            endpoint: endpoint,
            world: () => live,
            start: async input => { asked.push(input.name); live = WORLD; return WORLD },
            body: fake,
            limits: { spares: 1, max: 2 },
        })
        pool.start()
        await settle()

        const held = await pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve", world: "Axon_Town" })
        expect(asked).toEqual(["Axon_Town"])
        expect(held.world).toBe("Axon_Town")
        await pool.stop()
    })

    test("names none, and the one already running answers", async () => {
        const asked: string[] = []
        const pool = Pool({
            endpoint: endpoint,
            world: () => WORLD,
            start: async input => { asked.push(input.name); return WORLD },
            body: fake,
            limits: { spares: 1, max: 2 },
        })
        pool.start()
        await settle()

        const held = await pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" })
        expect(asked).toEqual([])
        expect(held.world).toBe("Axon_Town")
        await pool.stop()
    })

    test("names none and none is running: refused, never guessed at", async () => {
        const pool = Pool({
            endpoint: endpoint,
            world: () => null,
            start: async () => { throw new Error("should not be asked") },
            body: fake,
        })
        await expect(pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" }))
            .rejects.toThrow(/names none to start/)
    })

    test("a scenario is a run, not a lease — refused here rather than quietly dropped", async () => {
        const pool = Pool({
            endpoint: endpoint,
            world: () => WORLD,
            start: async () => WORLD,
            body: fake,
            limits: { spares: 1, max: 2 },
        })
        await expect(pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve", world: "Axon_Town", scenario: "flee" }))
            .rejects.toThrow(/a scenario is a run/)
    })

    test("the lease says which world its body is in, so a lab serving several can tell them apart", async () => {
        const pool = Pool({
            endpoint: endpoint,
            world: () => WORLD,
            start: async () => WORLD,
            body: fake,
            limits: { spares: 1, max: 2 },
        })
        pool.start()
        await settle()
        await pool.lease({ agent: "steve", pid: process.pid, identity: "Steve", stateDir: "/tmp/steve" })
        expect(pool.leases().map(lease => lease.world)).toEqual(["Axon_Town"])
        expect(pool.list().find(body => body.state === "embodied")?.world).toBe("Axon_Town")
        await pool.stop()
    })
})

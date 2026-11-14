import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { wire } from "@arcforge/body"
import { AtriumLab } from "../../src/labs/atrium"

/**
 * Atrium as the daemon runs it: the checkout's own build, a world served
 * over the world contract, a body leased by name and worn with its token.
 * Needs Atrium built (cargo build --release in apps/atrium): the lab says so
 * by name when it is not, and this fails with it.
 */
const SOURCE = resolve(import.meta.dir, "../../../../../../apps/atrium")
const roots: string[] = []

async function lab() {
    const root = await mkdtemp(join(tmpdir(), "axond-atrium-"))
    roots.push(root)
    return AtriumLab({ root: root, source: SOURCE, library: join(root, "library") })
}

afterAll(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** The next message the body says of `type`. */
function next(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
    return new Promise((done, failed) => {
        const heard = (event: MessageEvent) => {
            const said = JSON.parse(String(event.data))
            if (said.type !== type) return
            socket.removeEventListener("message", heard)
            done(said)
        }
        socket.addEventListener("message", heard)
        socket.addEventListener("close", event => failed(new Error(`closed: ${event.reason}`)))
    })
}

describe("the Atrium lab", () => {
    test("lists the library's worlds, serves one, and puts an agent in the body it names", async () => {
        const atrium = await lab()
        const before = await atrium.state()
        expect(before.problem).toBeNull()
        expect(before.worlds.map(world => world.name)).toContain("flat")
        expect((await atrium.library.list()).find(entry => entry.kind === "body" && entry.name === "probe")).toBeDefined()

        await atrium.start({ name: "flat" })
        try {
            const running = (await atrium.state()).running[0]!
            expect(running.state).toBe("running")
            const scene = running.observers.find(observer => observer.kind === "geometry")!
            expect(scene.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/view$/)

            await expect(atrium.bodies.lease({ agent: "terry", pid: process.pid, identity: "Terry", stateDir: "/tmp/terry" })).rejects.toThrow("say which to wear")
            const leased = await atrium.bodies.lease({ agent: "terry", pid: process.pid, identity: "Terry", stateDir: "/tmp/terry", body: "probe" })
            expect(leased.world).toBe("flat")
            expect(leased.endpoint).toBe(`${scene.url.replace("/view", "/body")}/Terry`)

            const socket = new WebSocket(`${leased.endpoint}?token=${leased.token}`)
            const said = await next(socket, "manifest")
            const manifest = wire.fromBody(JSON.stringify(said), null)
            expect(manifest.type === "manifest" && manifest.manifest.kind).toBe("atrium:probe")
            await Bun.sleep(2_500)
            const body = (await atrium.state()).bodies.find(found => found.id === "Terry")!
            expect(body.state).toBe("embodied")
            expect(body.model).toBe("probe")
            expect(body.client).toBeNull()

            await atrium.bodies.release(leased.lease)
            expect((await atrium.state()).bodies).toEqual([])
            socket.close()
        } finally {
            await atrium.stop()
        }
        expect((await atrium.state()).running).toEqual([])
    }, 30_000)

    /**
     * The whole point of an address naming a world: two agents, two worlds,
     * one lab, at once. A lab that served one at a time would have stopped
     * the first world to start the second — silently, out from under whoever
     * was in it.
     */
    test("serves several worlds beside each other, and an address starts the one it names", async () => {
        const atrium = await lab()
        // A second world of its own: `flat` is built into the binary, so one
        // more is imported rather than assuming the machine's library holds one.
        await atrium.library.import({ file: join(SOURCE, "assets", "worlds", "flat", "scene.xml"), name: "flat-two", as: "world" })
        const names = (await atrium.state()).worlds.map(world => world.name)
        const first = "flat"
        const second = "flat-two"
        expect(names).toContain(first)
        expect(names).toContain(second)

        try {
            // No world named and none running: refused, rather than guessed at.
            await expect(atrium.bodies.lease({ agent: "a", pid: process.pid, identity: "A", stateDir: "/tmp/a", body: "probe" }))
                .rejects.toThrow("names none to start")

            // The address names a world, so the lease brings it up.
            const one = await atrium.bodies.lease({ agent: "a", pid: process.pid, identity: "A", stateDir: "/tmp/a", world: first, body: "probe" })
            expect(one.world).toBe(first)

            // And a second agent elsewhere, beside it — not instead of it.
            const two = await atrium.bodies.lease({ agent: "b", pid: process.pid, identity: "B", stateDir: "/tmp/b", world: second, body: "probe" })
            expect(two.world).toBe(second)

            const state = await atrium.state()
            expect(state.running.map(world => world.name).sort()).toEqual([first, second].sort())
            // Each world serves its own view: two scenes, not one shared.
            expect(new Set(state.running.map(world => world.observers[0]!.url)).size).toBe(2)
            // Every body says which world it is in, and so does every lease.
            expect(state.bodies.map(body => body.world).sort()).toEqual([first, second].sort())
            expect(state.leases.map(lease => lease.world).sort()).toEqual([first, second].sort())

            // Asking again for a world already up joins it rather than restarting it.
            const held = state.running.find(world => world.name === first)!
            expect((await atrium.start({ name: first })).pid).toBe(held.pid)

            // One stopped leaves the other serving.
            await atrium.stop({ name: first })
            expect((await atrium.state()).running.map(world => world.name)).toEqual([second])
        } finally {
            await atrium.stop()
        }
        expect((await atrium.state()).running).toEqual([])
    }, 60_000)

    test("refuses what it cannot do, by name", async () => {
        const atrium = await lab()
        await expect(atrium.bodies.lease({ agent: "terry", pid: process.pid, identity: "Terry", stateDir: "/tmp/terry", body: "probe" })).rejects.toThrow("names none to start")
        await expect(atrium.start({ name: "nowhere" })).rejects.toThrow("has no world nowhere")
        await expect(atrium.bodies.lease({ agent: "terry", pid: process.pid, identity: "Terry", stateDir: "/tmp/terry", world: "flat", scenario: "whatever", body: "probe" })).rejects.toThrow("no scenarios")
        expect((await atrium.state()).running).toEqual([])
    }, 30_000)
})

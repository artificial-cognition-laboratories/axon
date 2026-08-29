import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Axond, AxonDaemon } from "../../src/index.ts"

/**
 * The transport — a real socket, a real client.
 *
 * Tested ONCE, here, rather than in every domain's suite. The domains are
 * exercised in-process against `Axond()`; what this proves is that a verb
 * reached over the wire behaves like the same verb called directly, including
 * when it throws.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function served() {
    const root = await mkdtemp(join(tmpdir(), "axond-wire-"))
    roots.push(root)
    const axond = Axond({ root: root, version: "9.9.9" })
    await axond.serve()
    return { axond: axond, client: AxonDaemon({ root: root }) }
}

describe("the control socket", () => {
    test("a client with no daemon fails loudly, naming the fix", async () => {
        // The ordinary case, not a fault: nothing is running, and the caller
        // needs to be told to start one rather than shown a socket error.
        const root = await mkdtemp(join(tmpdir(), "axond-wire-"))
        roots.push(root)

        const client = AxonDaemon({ root: root })

        await expect(client.machine.state()).rejects.toThrow(/no daemon listening/i)
    })

    test("constructing a client connects to nothing", async () => {
        // A handle is built whether or not a daemon exists — the same rule
        // AxonCloud() follows for a missing key.
        const root = await mkdtemp(join(tmpdir(), "axond-wire-"))
        roots.push(root)

        expect(() => AxonDaemon({ root: root })).not.toThrow()
    })

    test("a wired domain's answer crosses the wire intact", async () => {
        const { axond, client } = await served()
        try {
            const state = await client.machine.state()

            expect(state.capacity.cores).toBeGreaterThan(0)
            expect(state.identity.hostname.length).toBeGreaterThan(0)
        } finally {
            await axond.shutdown()
        }
    })

    test("an argument reaches the domain rather than being dropped", async () => {
        // `admit` is the first verb taking one, and a wire that silently
        // passed undefined would make every admission read as unbounded.
        const { axond, client } = await served()
        try {
            const verdict = await client.machine.admit(1)

            expect(verdict.ok).toBe(true)
        } finally {
            await axond.shutdown()
        }
    })

    test("a domain's error crosses the wire rather than vanishing", async () => {
        const { axond, client } = await served()
        try {
            // A client that got a 200 with no value could not tell "returned
            // nothing" from "threw" — so an unwired domain is the case worth
            // proving, and agents is still one.
            await expect(
                (client as unknown as { schedule: { list: () => Promise<unknown> } }).schedule.list(),
            ).rejects.toThrow(/not wired/i)
        } finally {
            await axond.shutdown()
        }
    })

    test("an unknown verb is refused, not silently ignored", async () => {
        const { axond } = await served()
        try {
            // Posted RAW rather than through the client, because the client's
            // surface has no such verb to call — what is under test is the
            // server's dispatch, which any process can reach.
            const response = await fetch("http://localhost/", {
                unix: axond.paths.socket,
                method: "POST",
                body: JSON.stringify({ path: ["machine", "nope"], arg: undefined }),
            })
            const body = (await response.json()) as { ok: boolean; error?: string }

            expect(body.ok).toBe(false)
            expect(body.error).toMatch(/no such verb/i)
        } finally {
            await axond.shutdown()
        }
    })

    test("a malformed request is refused rather than crashing the daemon", async () => {
        const { axond } = await served()
        try {
            const response = await fetch("http://localhost/", {
                unix: axond.paths.socket,
                method: "POST",
                body: JSON.stringify({ nonsense: true }),
            })

            expect(response.status).toBe(400)
            // The daemon has to survive it — one bad client must not take down
            // the process every other agent depends on.
            expect(axond.lifecycle.status().running).toBe(true)
        } finally {
            await axond.shutdown()
        }
    })

    test("the socket is gone after shutdown, so the next start binds cleanly", async () => {
        const { axond } = await served()
        expect(existsSync(axond.paths.socket)).toBe(true)

        await axond.shutdown()

        expect(existsSync(axond.paths.socket)).toBe(false)
    })

    test("a daemon can be restarted on the same root", async () => {
        // The stale-socket case: a start that could not rebind after a clean
        // stop would make restart impossible without manual cleanup.
        const { axond } = await served()
        const root = axond.paths.root
        await axond.shutdown()

        const second = Axond({ root: root })
        await second.serve()
        try {
            expect(second.lifecycle.status().running).toBe(true)
        } finally {
            await second.shutdown()
        }
    })
})

describe("a verb that calls a sibling", () => {
    /**
     * The regression this exists for: `Dispatch` used to walk to the function
     * and invoke it bare, so `this` was undefined inside it. Every verb that
     * reached a sibling through `this` — `models.fetch` calling `refresh`,
     * `agents.state` calling `list` — worked in-process and threw only over
     * the socket, which is the worst place to find out.
     */
    test("resolves it over the wire, as it does in process", async () => {
        const { axond, client } = await served()

        // `state` reads `this.list()`. A detached call throws here.
        expect((await client.agents.state()).agents).toEqual(axond.agents.state().agents)

        await axond.shutdown()
    })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AxonInstance } from "@arcforge/types"
import { AxonCloud } from "@arcforge/cloud"
import { Store } from "@arcforge/platform/store"
import { Network, type SimMachine } from "../setup/network"
import { errorMap } from "@arcforge/err"
import { OTHER_USER, TEST_USER } from "../setup/user"

/**
 * The simulated network itself. Every machine-network test stands on this:
 * if two daemons in one process could see each other's state, no test built
 * on them could tell one box from another.
 */
const network = Network()
afterEach(() => network.dispose())

/** A running record, as a daemon writes one when it boots an agent. */
function run(store: string, session: string): void {
    const running = join(store, "cache", "running")
    mkdirSync(running, { recursive: true })
    const record: AxonInstance = {
        pid: process.pid,
        sessionId: session,
        agentName: "@test/agent",
        projectRoot: "/nowhere",
        dataRoot: "/nowhere/.agent/data",
        startedAt: new Date().toISOString(),
    }
    writeFileSync(join(running, `${session}.json`), JSON.stringify(record))
}

describe("simulated machines", () => {
    test("each daemon serves on its own socket", async () => {
        const laptop = await network.machine("laptop")
        const homelab = await network.machine("homelab")

        expect(laptop.axond.paths.socket).not.toBe(homelab.axond.paths.socket)
        const [a, b] = await Promise.all([laptop.client.machine.state(), homelab.client.machine.state()])
        expect(a.capacity.cores).toBeGreaterThan(0)
        expect(b.capacity.cores).toBeGreaterThan(0)
    })

    test("each daemon reads its own login, never the real one or a sibling's", async () => {
        const mine = await network.machine("mine")
        const theirs = await network.machine("theirs", { user: OTHER_USER })
        const fresh = await network.machine("fresh", { user: null })

        expect(await mine.client.identity.read()).toEqual({ signedIn: true, email: TEST_USER.email })
        expect(await theirs.client.identity.read()).toEqual({ signedIn: true, email: OTHER_USER.email })
        expect((await fresh.client.identity.read()).signedIn).toBe(false)
    })

    test("an agent running on one machine is not seen by another", async () => {
        const laptop = await network.machine("laptop")
        const homelab = await network.machine("homelab")
        run(homelab.axond.paths.store, "on-homelab")

        expect((await homelab.client.agents.list()).map(agent => agent.sessionId)).toEqual(["on-homelab"])
        expect(await laptop.client.agents.list()).toEqual([])
    })
})

describe("machines on the network", () => {
    test("each machine joins with its own key, as a member of its account's network", async () => {
        const laptop = await network.machine("laptop", { network: true })
        const homelab = await network.machine("homelab", { network: true })

        const [a, b] = await Promise.all([laptop.client.net.status(), homelab.client.net.status()])
        if (a.state !== "up" || b.state !== "up") throw new Error("both machines must be on the network")
        expect(a.id).not.toBe(b.id)
        expect(a.membership).toEqual({ state: "member" })
        expect(b.membership).toEqual({ state: "member" })
    })

    test("a machine of the same account is answered — through the directory, not by address", async () => {
        const laptop = await network.machine("laptop", { network: true })
        const homelab = await network.machine("homelab", { network: true })
        const there = await peer(laptop, homelab)

        const { value } = await laptop.axond.net.request(there, { path: ["machine", "state"] })

        expect(value).toEqual(expect.objectContaining({ hostname: expect.any(String), capacity: expect.any(Object) }))
    })

    test("a machine of another account is refused", async () => {
        const mine = await network.machine("mine", { network: true })
        const theirs = await network.machine("theirs", { network: true, user: OTHER_USER })
        const status = await mine.axond.net.status()
        if (status.state !== "up") throw new Error("mine is not on the network")

        await expect(theirs.axond.net.request({ key: status.id, addrs: status.addrs }, { path: ["machine", "state"] }))
            .rejects.toThrow(expect.objectContaining({ code: errorMap.NET_REFUSED.code, message: expect.stringContaining("not a machine on this account") }))
    })

    test("a machine removed from the network is refused from then on", async () => {
        const laptop = await network.machine("laptop", { network: true })
        const homelab = await network.machine("homelab", { network: true })
        const there = await peer(laptop, homelab)
        await laptop.axond.net.request(there, { path: ["machine", "state"] })

        const status = await laptop.axond.net.status()
        if (status.state !== "up") throw new Error("laptop is not on the network")
        await AxonCloud({ key: TEST_USER.apiKey }).user.machines.revoke(status.id)

        await expect(laptop.axond.net.request(there, { path: ["machine", "state"] }))
            .rejects.toThrow(expect.objectContaining({ code: errorMap.NET_REFUSED.code, message: expect.stringContaining("removed") }))
    })

    test("a signed-out machine stays off the network entirely, and says why", async () => {
        const fresh = await network.machine("fresh", { network: true, user: null })

        // No sidecar at all: a machine with no account must not announce its key to anyone.
        expect(await fresh.client.net.status()).toEqual({ state: "down", problem: "not signed in" })
    })

    test("signing in after the daemon started joins it, without a restart", async () => {
        const late = await network.machine("late", { network: true, user: null })
        Store({ root: late.axond.paths.store }).profiles.save(TEST_USER.id, {
            user: { id: TEST_USER.id, email: TEST_USER.email },
            auth: { apiKey: TEST_USER.apiKey },
        })

        await late.client.net.join()

        const status = await late.client.net.status()
        expect(status.state === "up" && status.membership).toEqual({ state: "member" })
    })

    test("a running agent crosses without its control channel", async () => {
        const laptop = await network.machine("laptop", { network: true })
        const homelab = await network.machine("homelab", { network: true })
        run(homelab.axond.paths.store, "on-homelab")

        const { value } = await laptop.axond.net.request(await peer(laptop, homelab), { path: ["agents", "list"] })

        expect(value).toEqual([expect.objectContaining({ session: "on-homelab" })])
        expect(JSON.stringify(value)).not.toContain("token")
    })

    test("a terminal lists the account's machines and calls one, typed, through its own daemon", async () => {
        const laptop = await network.machine("laptop", { network: true })
        const homelab = await network.machine("homelab", { network: true })
        const there = await homelab.client.net.status()
        if (there.state !== "up") throw new Error("homelab is not on the network")

        const listed = await laptop.client.machines.list()
        expect(listed.find(machine => machine.key === there.id)).toEqual(expect.objectContaining({ self: false, online: true }))
        expect(listed.filter(machine => machine.self)).toHaveLength(1)

        const state = await laptop.client.machines.at(there.id).machine.state()
        expect(state.capacity.cores).toBeGreaterThan(0)
    })

    test("calling a machine that is not on the network is refused before any dial", async () => {
        const laptop = await network.machine("laptop", { network: true })
        const stranger = await network.machine("stranger", { network: true, user: OTHER_USER })
        const theirs = await stranger.client.net.status()
        if (theirs.state !== "up") throw new Error("stranger is not on the network")

        await expect(laptop.client.machines.at(theirs.id).machine.state())
            .rejects.toThrow(expect.objectContaining({ code: errorMap.NET_REFUSED.code, message: expect.stringContaining("not a machine on your network") }))
    })

    test("a daemon off the network reports so, rather than an empty address", async () => {
        const offline = await network.machine("offline")

        expect(await offline.client.net.status()).toEqual({ state: "down", problem: "not started" })
    })
})

/** Another machine as `from` finds it: by key in the directory, with the addresses it reported. */
async function peer(from: SimMachine, to: SimMachine) {
    const status = await to.axond.net.status()
    if (status.state !== "up") throw new Error(`${to.name} is not on the network`)
    const entry = (await from.axond.net.directory.list()).find(machine => machine.key === status.id)
    if (!entry) throw new Error(`${to.name} is not in ${from.name}'s directory`)
    return { key: entry.key, addrs: entry.addrs }
}

describe("attach across machines — refusals", () => {
    test("an agent that is not running there is not found, and says so", async () => {
        const laptop = await network.machine("laptop", { network: true })
        const homelab = await network.machine("homelab", { network: true })
        const there = await homelab.client.net.status()
        if (there.state !== "up") throw new Error("homelab is not on the network")

        await expect(laptop.client.machines.at(there.id).attach("no-such-session")).rejects.toThrow(/not ready \(404\) no agent with session no-such-session/)
    })

    test("only an agent's /_axon surface can be reached, never its own routes", async () => {
        const laptop = await network.machine("laptop", { network: true })
        const homelab = await network.machine("homelab", { network: true })
        const there = await homelab.client.net.status()
        if (there.state !== "up") throw new Error("homelab is not on the network")

        await expect(laptop.axond.net.machines.fetch(there.id, { session: "x", method: "GET", path: "/admin", headers: {}, body: null }))
            .rejects.toThrow(expect.objectContaining({ code: errorMap.NET_REFUSED.code, message: expect.stringContaining("/_axon/") }))
    })
})

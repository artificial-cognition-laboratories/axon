import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Agents } from "../../src/agents/index.ts"
import type { AxonInstance } from "@arcforge/types"

/**
 * The agents domain, driven through `Agents()` directly.
 *
 * Records are written as FILES rather than through a fake, because the file IS
 * the protocol — a running agent publishes one and every reader pid-checks it.
 * Testing against a stub registry would prove the daemon can read a shape it
 * invented, which is not the property that matters.
 *
 * `process.pid` stands in for a live agent: it is the one pid guaranteed to be
 * alive for the length of the test, and liveness is exactly what the registry
 * decides on.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function agents(machineId: string | null = "test-machine") {
    const root = await mkdtemp(join(tmpdir(), "axond-agents-"))
    roots.push(root)
    // ISOLATED: without it these read the developer's own ~/.axon, and every
    // assertion about an empty machine passes only while nothing is running.
    return { agents: Agents({ root: root, isolated: true, machineId: () => machineId }), root: root }
}

/** A record on disk, as a running agent would write one. */
async function record(root: string, input: Partial<AxonInstance> & { sessionId: string }): Promise<void> {
    const instance: AxonInstance = {
        pid: process.pid,
        agentName: input.agentName ?? "@test/agent",
        projectRoot: input.projectRoot ?? "/tmp/project",
        dataRoot: input.dataRoot ?? "/tmp/project/.agent/data",
        startedAt: input.startedAt ?? new Date().toISOString(),
        // Spread LAST so an explicit pid (a dead one, for the liveness tests)
        // wins over the default rather than being silently overwritten.
        ...input,
    }
    await writeFile(join(root, `${instance.sessionId}.json`), JSON.stringify(instance))
}

describe("listing", () => {
    test("an empty machine lists nothing rather than throwing", async () => {
        const { agents: a } = await agents()

        expect(a.list()).toEqual([])
    })

    test("a published record is listed", async () => {
        const { agents: a, root } = await agents()
        await record(root, { sessionId: "alpha", agentName: "@cody/barry" })

        const [found] = a.list()

        expect(found?.sessionId).toBe("alpha")
        expect(found?.agentName).toBe("@cody/barry")
    })

    test("every record names the machine it runs on", async () => {
        // Today there is one daemon and the machine is implied. It stops being
        // implied the moment a second is managed from elsewhere, and a record
        // that cannot say which box it describes is a migration, not a field.
        const { agents: a, root } = await agents("box-42")
        await record(root, { sessionId: "alpha" })

        expect(a.list()[0]?.machineId).toBe("box-42")
    })

    test("an unidentifiable machine reports null, never an invented id", async () => {
        const { agents: a, root } = await agents(null)
        await record(root, { sessionId: "alpha" })

        expect(a.list()[0]?.machineId).toBeNull()
    })

    test("newest first", async () => {
        const { agents: a, root } = await agents()
        await record(root, { sessionId: "older", startedAt: "2020-01-01T00:00:00.000Z" })
        await record(root, { sessionId: "newer", startedAt: "2030-01-01T00:00:00.000Z" })

        expect(a.list().map(instance => instance.sessionId)).toEqual(["newer", "older"])
    })
})

describe("liveness", () => {
    test("a record whose process is gone is not listed", async () => {
        // The pid is the whole liveness proof. A stale record must never read
        // as a running agent.
        const { agents: a, root } = await agents()
        await record(root, { sessionId: "ghost", pid: 999_999 })

        expect(a.list()).toEqual([])
    })

    test("a dead record is reaped, not merely filtered", async () => {
        // Every reader already probes to answer honestly, so cleaning up while
        // it looks costs nothing — and means no reaper exists to fail.
        const { agents: a, root } = await agents()
        await record(root, { sessionId: "ghost", pid: 999_999 })

        a.list()

        expect(await Bun.file(join(root, "ghost.json")).exists()).toBe(false)
    })

    test("a malformed record does not empty the whole view", async () => {
        // A write torn mid-flush must cost one agent, never every reader's
        // ability to see any.
        const { agents: a, root } = await agents()
        await writeFile(join(root, "broken.json"), "{ not json")
        await record(root, { sessionId: "good" })

        expect(a.list().map(instance => instance.sessionId)).toEqual(["good"])
    })
})

describe("the instance handle", () => {
    test("at() returns a handle, not a record", async () => {
        // The SDK decision: an agent is something you talk to. A flat
        // request(id, msg) would need a translation layer to become one.
        const { agents: a, root } = await agents()
        await record(root, { sessionId: "alpha", agentName: "@cody/barry" })

        const handle = a.at("alpha")

        expect(handle?.id).toBe("alpha")
        expect(handle?.alive()).toBe(true)
        expect(handle?.record()?.agentName).toBe("@cody/barry")
    })

    test("at() is null for an agent that is not running", async () => {
        const { agents: a } = await agents()

        expect(a.at("nothing")).toBeNull()
    })

    test("a handle re-reads rather than reporting what it was built from", async () => {
        // A handle held across a shutdown must report the shutdown.
        const { agents: a, root } = await agents()
        await record(root, { sessionId: "alpha" })
        const handle = a.at("alpha")!

        await rm(join(root, "alpha.json"))

        expect(handle.alive()).toBe(false)
        expect(handle.record()).toBeNull()
    })

    test("an OBSERVED agent reports that it is not supervised", async () => {
        // The distinction decides which verbs work, so it is reported rather
        // than discovered by calling one and being refused.
        const { agents: a, root } = await agents()
        await record(root, { sessionId: "alpha" })

        expect(a.at("alpha")!.supervised).toBe(false)
    })

    test("talking to an observed agent is refused, naming why", async () => {
        // Its link belongs to the process that spawned it. A verb that
        // appeared to work and dropped the message is the failure this
        // prevents — and the gap that closes when every agent is
        // daemon-supervised.
        const { agents: a, root } = await agents()
        await record(root, { sessionId: "alpha" })
        const handle = a.at("alpha")!

        const stimulus = { type: "cognet:stimulus:text", data: { content: "hi" } } as never
        expect(() => handle.stimulus(stimulus)).toThrow(/does not supervise/i)
        expect(() => handle.request(stimulus)).toThrow(/does not supervise/i)
        expect(() => handle.session).toThrow(/does not supervise/i)
    })
})

describe("stopping", () => {
    test("stopping something that is not running is false, not an error", async () => {
        // "Stopped nothing" and "stopped something" are different answers.
        const { agents: a } = await agents()

        expect(a.stop("nothing")).toBe(false)
    })
})

describe("spawning", () => {
    test("a daemon with no credential refuses to supervise, naming why", async () => {
        // The credential is what a supervisor exists to hold. A daemon built
        // without one is a registry reader, and saying so beats failing later
        // inside a boot with something obscure.
        const { agents: a } = await agents()

        await expect(a.spawn({
            sessionId: "alpha",
            blueprint: {} as never,
            agent: "@test/agent",
            projectRoot: "/tmp/p",
            dataRoot: "/tmp/p/.agent/data",
        })).rejects.toThrow(/no credential/i)
    })
})

describe("watching", () => {
    test("a subscriber is called immediately with the current list", async () => {
        const { agents: a, root } = await agents()
        await record(root, { sessionId: "alpha" })

        const seen: number[] = []
        const stop = a.watch(list => seen.push(list.length))
        stop()
        a.dispose()

        expect(seen).toEqual([1])
    })

    test("unsubscribing stops the watchers, leaving no timer behind", async () => {
        const { agents: a } = await agents()

        const stop = a.watch(() => {})
        stop()
        a.dispose()

        // Nothing to assert beyond the suite not hanging: a poll left running
        // would keep the process alive past the test.
        expect(a.list()).toEqual([])
    })
})

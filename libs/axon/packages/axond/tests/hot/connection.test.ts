import { describe, expect, test } from "bun:test"
import { err } from "@arcforge/err"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Connection } from "../../src/control/connection"
import { socketFault } from "../../src/control/caller"
import { Axond, AxonDaemon } from "../../src/index.ts"

/**
 * Connection — the client's one answer to "can I reach a daemon".
 *
 * Regression for Fleet reporting "no daemon running": it tried to start one
 * exactly once per editor session, and the labs client never tried at all, so
 * a daemon that died (or was replaced by an update) stayed "not running" until
 * the editor restarted.
 */
const notRunning = () => err("DAEMON_NOT_RUNNING", { detail: "no daemon" })

describe("Connection", () => {
    test("the first request launches, later ones do not", async () => {
        let launches = 0
        const connection = Connection({ launch: async () => { launches++ } })
        await connection.through(async () => 1)
        await connection.through(async () => 2)
        expect(launches).toBe(1)
    })

    test("concurrent first requests share one launch", async () => {
        let launches = 0
        const connection = Connection({ launch: async () => { launches++; await Bun.sleep(10) } })
        await Promise.all([connection.through(async () => 1), connection.through(async () => 2)])
        expect(launches).toBe(1)
    })

    test("a daemon that vanished is relaunched once and the request retried", async () => {
        let launches = 0
        let calls = 0
        const connection = Connection({ launch: async () => { launches++ } })
        await connection.through(async () => 0)
        const value = await connection.through(async () => {
            calls++
            if (calls === 1) throw notRunning()
            return "answered"
        })
        expect(value).toBe("answered")
        expect(launches).toBe(2)
    })

    test("a dropped request is never retried — it may have been acted on", async () => {
        let calls = 0
        const connection = Connection({ launch: async () => {} })
        await expect(connection.through(async () => {
            calls++
            throw err("DAEMON_CONNECTION_LOST", { detail: "EPIPE" })
        })).rejects.toMatchObject({ code: "AX-DAEMON-009" })
        expect(calls).toBe(1)
    })

    test("a failed launch is the answer for the cooldown, not retried every poll", async () => {
        let launches = 0
        const connection = Connection({ launch: async () => { launches++; throw new Error("axon not on PATH") } })
        await expect(connection.ensure()).rejects.toThrow("axon not on PATH")
        await expect(connection.ensure()).rejects.toThrow("axon not on PATH")
        expect(launches).toBe(1)
    })

    test("with no launcher, verbs fail naming the fix", async () => {
        const connection = Connection({})
        await expect(connection.through(async () => { throw notRunning() })).rejects.toMatchObject({ code: "AX-DAEMON-001" })
    })
})

describe("socketFault", () => {
    test("only a connection that never opened is 'not running'", () => {
        expect(socketFault(Object.assign(new Error("x"), { code: "ENOENT" }), "/s", "v")).toMatchObject({ code: "AX-DAEMON-001" })
        expect(socketFault(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "/s", "v")).toMatchObject({ code: "AX-DAEMON-001" })
        expect(socketFault(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }), "/s", "v")).toMatchObject({ code: "AX-DAEMON-009" })
    })
})

describe("AxonDaemon with a launcher", () => {
    test("the first verb starts the daemon it needs", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-launch-"))
        const server = Axond({ root: root, version: "9.9.9" })
        const client = AxonDaemon({ root: root, launch: () => server.serve() })
        try {
            expect(client.status().running).toBe(false)
            expect(await client.machine.state()).toBeTruthy()
            expect(client.status().running).toBe(true)
        } finally {
            await server.shutdown()
            await rm(root, { recursive: true, force: true })
        }
    })
})

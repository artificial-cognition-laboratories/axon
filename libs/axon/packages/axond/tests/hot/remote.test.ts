import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errorMap } from "@arcforge/err"
import type { AxonInstance } from "@arcforge/types"
import { Agents } from "../../src/agents/index"
import { Remote } from "../../src/control/index"
import { Machine } from "../../src/machine/index"
import { Models } from "../../src/models/index"
import { Schedule } from "../../src/schedule/index"

/**
 * The remote surface is what leaves the box. These pin that it carries only
 * what its wire types name — never an agent's control token, pid or paths —
 * and that it speaks only for this distribution's store.
 */
const SECRET = "control-token-must-not-cross"
let scratch: string | null = null

afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = null
})

function machine() {
    scratch = mkdtempSync(join(tmpdir(), "axond-remote-"))
    const store = join(scratch, ".axon")
    const running = join(store, "cache", "running")
    mkdirSync(running, { recursive: true })
    const project = join(store, "profiles", "me", "agents", "zeno")
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, "axon.config.ts"), "export default {}")
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "@axon/zeno", version: "1.2.3" }))

    const record: AxonInstance = {
        pid: process.pid,
        sessionId: "s-1",
        agentName: "@axon/zeno",
        projectRoot: project,
        dataRoot: join(project, ".agent", "data"),
        startedAt: new Date().toISOString(),
        control: { port: 4242, token: SECRET },
    }
    writeFileSync(join(running, "s-1.json"), JSON.stringify(record))

    const agents = Agents({ store: store, stores: [store], root: running, isolated: true })
    const remote = Remote({
        peer: { machine: "peer-key", account: "me" },
        agents: agents,
        machine: Machine({ residencyRoot: join(scratch, "holds") }),
        models: Models({ root: join(scratch, "models"), machine: Machine({ residencyRoot: join(scratch, "holds") }) }),
        schedule: Schedule({ root: join(scratch, "schedule") }),
    })
    return { remote: remote, project: project }
}

describe("what crosses", () => {
    test("a running agent crosses without its control channel, pid or paths", async () => {
        const { remote, project } = machine()
        const listed = await remote.agents.list()

        expect(listed).toEqual([{ session: "s-1", name: "@axon/zeno", startedAt: expect.any(String), parent: null, job: null }])
        const sent = JSON.stringify(listed)
        expect(sent).not.toContain(SECRET)
        expect(sent).not.toContain(project)
        expect(sent).not.toContain(String(process.pid))
    })

    test("an installed project crosses without its local path", async () => {
        const { remote, project } = machine()
        const installed = await remote.agents.installed()

        expect(installed).toEqual([{ ref: "@axon/zeno", version: "1.2.3", profile: "me", usedAt: expect.any(Number) }])
        expect(JSON.stringify(installed)).not.toContain(project)
    })
})

describe("what it refuses", () => {
    test("stopping a session this store does not own is refused, not quietly false", async () => {
        const { remote } = machine()

        await expect(remote.agents.stop({ session: "not-mine" })).rejects.toThrow(expect.objectContaining({ code: errorMap.AGENT_NOT_FOUND.code }))
    })

    test("the local surface is not reachable through it", () => {
        const { remote } = machine()

        expect(Object.keys(remote).sort()).toEqual(["agents", "machine", "models", "schedule"])
        expect(Object.keys(remote.models)).toEqual(["state"])
    })
})

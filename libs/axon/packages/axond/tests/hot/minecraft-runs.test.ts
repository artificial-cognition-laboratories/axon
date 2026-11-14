import { afterAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runs, type RunHost } from "../../src/labs/minecraft/runs"
import { Worlds } from "../../src/labs/minecraft/worlds"
import type { ScenarioProgress, ScenarioRun } from "../../src/labs/types"

const root = await mkdtemp(join(tmpdir(), "axon-minecraft-runs-"))
afterAll(() => rm(root, { recursive: true, force: true }))

/** A lab world with one scenario and somebody's saved position in it. */
async function world(name: string): Promise<ReturnType<typeof Worlds>> {
    const dir = join(root, "worlds", name)
    await mkdir(join(dir, "axon", "scenarios"), { recursive: true })
    await mkdir(join(dir, "playerdata"), { recursive: true })
    await writeFile(join(dir, "level.dat"), "level")
    await writeFile(join(dir, "playerdata", "someone.dat"), "where they stood")
    await writeFile(join(dir, "axon", "scenarios", "flee.json"), "{}")
    return Worlds({ root: root, managed: join(root, "worlds"), prismGame: join(root, "prism"), minecraftSaves: join(root, "saves") })
}

/** A server that runs the scenario for `ticks` reads, then ends it; and an agent that takes a body at once. */
function fakes(agentRoot: string, ticks: number) {
    const calls: string[] = []
    let reads = 0
    let begun: string | null = null
    const run = (): ScenarioProgress => {
        if (!begun) return { scenario: "flee", phase: "waiting", seconds: 60, events: [] }
        reads++
        const began = { kind: "began" as const, at: 1, tick: 10, detail: begun }
        return reads >= ticks
            ? { scenario: "flee", phase: "ended", seconds: 60, subject: begun, events: [began, { kind: "ended", at: 2, tick: 1210, detail: "timeout" }] }
            : { scenario: "flee", phase: "running", seconds: 60, subject: begun, events: [began] }
    }
    const host: RunHost = {
        current: () => null,
        serve: async input => { calls.push(`serve ${input.env.AXONM_RUN_SCENARIO}`) },
        stop: async () => { calls.push("stop server") },
        leases: () => [{ id: "l", body: "body-1", world: "Axon_Town", agent: "@cody/terry", pid: 1, identity: "Terry", stateDir: join(agentRoot, ".agent", "data", "minecraft"), at: "" }],
        state: async () => ({ players: [{ name: "body-1" }], run: run() }),
        begin: async player => { begun = player; calls.push(`begin ${player}`) },
    }
    const launcher = {
        zeno: async () => "zeno",
        launch: async (ref: string) => {
            calls.push(`launch ${ref}`)
            return { session: "session-1", name: "@cody/terry", root: agentRoot, link: { request: async () => null }, stop: async () => { calls.push("stop agent") } }
        },
    }
    return { host: host, launcher: launcher, calls: calls }
}

async function settled(runs: ReturnType<typeof Runs>, id: string): Promise<ScenarioRun> {
    for (let i = 0; i < 100; i++) {
        const record = await runs.get({ id: id })
        if (record.endedAt) return record
        await Bun.sleep(100)
    }
    throw new Error(`run ${id} did not settle`)
}

test("a run copies the world without anyone's saved place, puts the agent through the scenario, and stops both", async () => {
    const worlds = await world("Osnea")
    const { host, launcher, calls } = fakes(join(root, "terry"), 2)
    const runs = Runs({ root: join(root, "runs"), worlds: worlds, launcher: launcher, host: host })

    const started = await runs.start({ world: "Osnea", scenario: "flee", agent: "@cody/terry" })
    const record = await settled(runs, started.id)

    expect(record.phase).toBe("ended")
    expect(record.outcome).toBe("timeout")
    expect(record.session).toBe("session-1")
    expect(record.subject).toBe("body-1")
    expect(record.events.map(event => event.kind)).toEqual(["began", "ended"])
    expect(calls).toEqual(["serve flee", "launch @cody/terry", "begin body-1", "stop agent", "stop server"])
    expect(existsSync(join(record.copy, "level.dat"))).toBe(true)
    expect(existsSync(join(record.copy, "playerdata"))).toBe(false)
    expect((await runs.list({ world: "Osnea" })).map(run => run.id)).toEqual([started.id])
})

test("a scenario the world does not have is refused by name, before anything starts", async () => {
    const worlds = await world("Eldaria")
    const { host, launcher, calls } = fakes(join(root, "terry"), 1)
    const runs = Runs({ root: join(root, "runs"), worlds: worlds, launcher: launcher, host: host })
    expect(runs.start({ world: "Eldaria", scenario: "missing", agent: "@cody/terry" })).rejects.toThrow("has no scenario missing — it has flee")
    expect(calls).toEqual([])
})

test("a cancelled run still stops its agent and its server", async () => {
    const worlds = await world("Cave")
    const { host, launcher, calls } = fakes(join(root, "terry"), 1_000)
    const runs = Runs({ root: join(root, "runs"), worlds: worlds, launcher: launcher, host: host })
    const started = await runs.start({ world: "Cave", scenario: "flee", agent: "@cody/terry" })
    while ((await runs.get({ id: started.id })).phase !== "running") await Bun.sleep(50)
    runs.cancel({ id: started.id })
    const record = await settled(runs, started.id)
    expect(record.phase).toBe("cancelled")
    expect(calls.slice(-2)).toEqual(["stop agent", "stop server"])
})

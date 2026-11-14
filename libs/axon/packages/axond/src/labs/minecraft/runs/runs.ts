import { randomBytes } from "node:crypto"
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, join, sep } from "node:path"
import { existsSync } from "node:fs"
import { err } from "@arcforge/err"
import type { Launched, LauncherT } from "../../../launcher/index"
import type { Lease, RunningWorld, ScenarioProgress, ScenarioRun } from "../../types"
import type { WorldsT } from "../worlds"

/** How long an agent has to take a body and stand in the world: a body boots, settles and joins in that. */
const EMBODY_MS = 300_000
/** How often a running scenario is read. */
const WATCH_MS = 1_000

/** What a run needs of the lab: one world served at a time, its bodies, and its server half. */
export type RunHost = {
    current(): RunningWorld | null
    /** Serves a copy of `name` from `level`, with `env` for the server half, and starts its bodies. */
    serve(input: { name: string; level: string; env: Record<string, string> }): Promise<void>
    stop(): Promise<void>
    leases(): Lease[]
    state(): Promise<{ players: Array<{ name: string }>; run: ScenarioProgress | null }>
    begin(player: string): Promise<void>
}

/**
 * Runs — one agent put through one scenario, start to finish, on a copy of
 * the world: copy it, serve the copy, boot the agent, wait for it to take a
 * body and stand in the world, begin, watch until the scenario ends, then stop
 * the agent (which closes its session) and the server. Whatever happens, the
 * agent and the server are stopped, and the run's record says what happened.
 *
 * The world is copied so every run starts from exactly what was authored, and
 * the copy is kept, as the run left it, beside its record.
 *
 * One at a time: the lab serves one world.
 */
export function Runs(opts: { root: string; worlds: WorldsT; launcher: LauncherT; host: RunHost }) {
    let active: { record: ScenarioRun; cancelled: boolean } | null = null

    function folder(id: string): string {
        if (!/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id)) throw err("WORLD_NOT_FOUND", { detail: `${id} is not a run id` })
        return join(opts.root, id)
    }

    /** The record, written whole and moved into place. */
    async function save(record: ScenarioRun): Promise<void> {
        const dir = folder(record.id)
        await mkdir(dir, { recursive: true })
        const staging = join(dir, "run.json.tmp")
        await writeFile(staging, JSON.stringify(record, null, 2) + "\n")
        await rename(staging, join(dir, "run.json"))
    }

    async function step(record: ScenarioRun, text: string, phase?: ScenarioRun["phase"]): Promise<void> {
        record.steps.push({ at: new Date().toISOString(), text: text })
        if (phase) record.phase = phase
        await save(record)
    }

    /** A run's record as this lab wrote it; one it cannot have written is refused by name. */
    async function read(input: { id: string }): Promise<ScenarioRun> {
        const file = join(folder(input.id), "run.json")
        if (!existsSync(file)) throw err("WORLD_NOT_FOUND", { detail: `there is no run ${input.id}` })
        const record: unknown = JSON.parse(await readFile(file, "utf-8"))
        if (typeof record !== "object" || record === null || !("id" in record) || record.id !== input.id || !("phase" in record) || !("steps" in record)) {
            throw new Error(`${file} is not a run this lab wrote`)
        }
        return record as ScenarioRun
    }

    function cancelled(): boolean {
        return active?.cancelled === true
    }

    /** The world copied for this run, with nobody's place in it remembered: every body joins at the scenario's spawn. */
    async function copy(record: ScenarioRun): Promise<void> {
        const source = await opts.worlds.path({ name: record.world })
        await cp(source, record.copy, { recursive: true, filter: path => basename(path) !== "session.lock" })
        await rm(join(record.copy, "playerdata"), { recursive: true, force: true })
    }

    /** The agent's lease once it has one, and its body standing in the world. */
    async function embodied(agent: Launched): Promise<Lease> {
        const deadline = Date.now() + EMBODY_MS
        const within = agent.root.endsWith(sep) ? agent.root : agent.root + sep
        while (Date.now() < deadline) {
            if (cancelled()) throw new Error("cancelled")
            const lease = opts.host.leases().find(held => held.stateDir.startsWith(within))
            // A warm body joined the world under its own name before any agent leased it, so that is its player's name.
            if (lease && (await opts.host.state()).players.some(player => player.name === lease.body)) return lease
            await Bun.sleep(1_000)
        }
        throw new Error(`${agent.name} did not take a body and stand in the world within ${EMBODY_MS / 1000}s — does it wear Minecraft? (AXON_CONNECT=world://localhost/minecraft/<world> in its .env)`)
    }

    /** Until the scenario ends: its events copied onto the record as they happen. */
    async function watch(record: ScenarioRun): Promise<void> {
        while (!cancelled()) {
            const run = (await opts.host.state()).run
            if (!run) throw new Error("the server is no longer running the scenario")
            if (run.events.length !== record.events.length) {
                record.events = run.events
                await save(record)
            }
            if (run.phase === "ended") {
                record.outcome = run.events.findLast(event => event.kind === "ended")?.detail ?? null
                return
            }
            await Bun.sleep(WATCH_MS)
        }
    }

    async function drive(record: ScenarioRun): Promise<void> {
        let agent: Launched | null = null
        try {
            await step(record, `Copying ${record.world}`)
            await copy(record)
            if (cancelled()) throw new Error("cancelled")
            await step(record, `Serving the copy for scenario ${record.scenario}`, "starting")
            await opts.host.serve({ name: record.world, level: record.copy, env: { AXONM_RUN_SCENARIO: record.scenario } })
            if (cancelled()) throw new Error("cancelled")
            await step(record, `Booting ${record.agent}`, "embodying")
            agent = await opts.launcher.launch(record.agent)
            record.session = agent.session
            record.agentRoot = agent.root
            await step(record, `${agent.name} is up as session ${agent.session}; waiting for it to take a body`)
            const lease = await embodied(agent)
            record.subject = lease.body
            await opts.host.begin(lease.body)
            await step(record, `${lease.identity} is in the world as ${lease.body}; the scenario began`, "running")
            await watch(record)
            if (cancelled()) throw new Error("cancelled")
            await step(record, `The scenario ended: ${record.outcome ?? "no reason given"}`, "ended")
        } catch (cause) {
            const reason = explain(cause)
            if (cancelled()) await step(record, "Cancelled", "cancelled")
            else {
                record.failure = reason
                await step(record, `Failed: ${reason}`, "failed")
            }
        } finally {
            // The agent first, through its link, so its session is closed with the world still there; then the server.
            const cleanup = await Promise.allSettled([agent ? agent.stop() : Promise.resolve(), opts.host.stop()])
            for (const result of cleanup) {
                if (result.status === "rejected") {
                    const reason = explain(result.reason)
                    record.failure = record.failure ? `${record.failure}; then ${reason}` : reason
                    record.phase = "failed"
                }
            }
            record.endedAt = new Date().toISOString()
            await step(record, "Stopped the agent and the server")
            active = null
        }
    }

    return {
        /** Begins a run, and returns its record at once; it carries on in the daemon, and `get` follows it. */
        async start(input: { world: string; scenario: string; agent: string }): Promise<ScenarioRun> {
            if (active) throw err("WORLD_ALREADY_RUNNING", { detail: `run ${active.record.id} is using the lab; cancel it or wait for it to end` })
            const running = opts.host.current()
            if (running) throw err("WORLD_ALREADY_RUNNING", { detail: `${running.name} is running; stop it before running a scenario` })
            const scenarios = await opts.worlds.scenarios({ name: input.world })
            if (!scenarios.includes(input.scenario)) {
                throw err("WORLD_NOT_FOUND", { detail: `${input.world} has no scenario ${input.scenario}${scenarios.length ? ` — it has ${scenarios.join(", ")}` : " — it has none yet; /scenario new in the world"}` })
            }
            const user = await opts.worlds.user({ name: input.world })
            if (user) throw err("WORLD_ALREADY_RUNNING", { detail: `${input.world} is open in Minecraft (process ${user}); leave it before running a scenario, or the copy could be half-saved` })
            const id = `${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${randomBytes(2).toString("hex")}`
            const record: ScenarioRun = {
                id: id, world: input.world, scenario: input.scenario, agent: input.agent,
                phase: "preparing", outcome: null, session: null, agentRoot: null, subject: null,
                events: [], steps: [], failure: null, copy: join(folder(id), "world"),
                createdAt: new Date().toISOString(), endedAt: null,
            }
            await save(record)
            active = { record: record, cancelled: false }
            void drive(record)
            return record
        },

        get: read,

        /** Every run, newest first; only `world`'s, when given. */
        async list(input: { world?: string } = {}): Promise<ScenarioRun[]> {
            if (!existsSync(opts.root)) return []
            const ids = (await readdir(opts.root)).filter(id => /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id)).sort().reverse()
            const runs = await Promise.all(ids.map(id => read({ id: id })))
            return input.world ? runs.filter(run => run.world === input.world) : runs
        },

        /** Stops the run under way; its agent and server are stopped as for any other ending. */
        // Async to match the lab contract every lab answers; cancelling is a
        // flag flip here, but a lab whose runs live elsewhere will have to wait.
        async cancel(input: { id: string }): Promise<void> {
            if (!active || active.record.id !== input.id) throw err("WORLD_NOT_FOUND", { detail: `run ${input.id} is not under way` })
            active.cancelled = true
        },

        /** Whether a run is using the lab — the lab's own start and stop must not pull its world out from under it. */
        active(): string | null {
            return active?.record.id ?? null
        },
    }
}

export type RunsT = ReturnType<typeof Runs>

/** What went wrong, whole: a failure made of several says each of them, not only that there were several. */
function explain(cause: unknown): string {
    if (cause instanceof AggregateError) return `${cause.message}: ${cause.errors.map(explain).join("; ")}`
    return cause instanceof Error ? cause.message : String(cause)
}

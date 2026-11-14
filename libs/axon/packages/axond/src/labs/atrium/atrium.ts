import { join } from "node:path"
import { err } from "@arcforge/err"
import { Interventions } from "../interventions"
import { Processes } from "../processes"
import type { AtriumAction, BodyInfo, Embodiment, LabAction, LabActionResult, LabState, Lease, LeaseInput, Notice, RunningWorld, ScenarioRun } from "../types"
import { Binary } from "./binary"
import { Library } from "./library"
import { Worlds } from "./worlds"

export type AtriumLabOpts = {
    /** The lab's state folder: its staged binary, its worlds' senses, its process ledger. */
    root: string
    /** The Atrium Cargo project; see Binary. */
    source?: string
    /** A library of its own — a test's. Absent: Atrium's own, shared with whoever imports at a terminal. */
    library?: string
}

const CONTROLS: Array<AtriumAction["kind"]> = ["world.reset", "world.pace"]

/**
 * AtriumLab — Axon's own lab: any body, in any world, with real physics.
 *
 * Its worlds are the library's — imported once from wherever they were
 * found, baked by Atrium — and as many are served at once as are asked for,
 * each as `atrium serve` run over the world contract. Its bodies are the
 * library's too: an agent's address names the world to be in and the body to
 * wear, the world is started if it is not already up, and the body is placed
 * in it and worn over the body contract straight from the world.
 *
 * A pure orchestrator: `Worlds` owns what is running, each world owns its
 * own bodies, and this fans the lab's verbs across them.
 */
export function AtriumLab(opts: AtriumLabOpts) {
    const binary = Binary({ root: opts.root, ...(opts.source ? { source: opts.source } : {}) })
    const library = Library({ binary: binary, ...(opts.library ? { root: opts.library } : {}) })
    const processes = Processes({ ledger: join(opts.root, "pids.json") })
    const notices: Notice[] = []
    const notice = (text: string) => {
        notices.push({ at: new Date().toISOString(), text: text })
        if (notices.length > 100) notices.splice(0, notices.length - 100)
    }
    const worlds = Worlds({
        binary: binary,
        library: library,
        processes: processes,
        root: opts.root,
        notice: (world, text) => notice(`${world}: ${text}`),
    })
    const interventions = Interventions({ root: opts.root, execute: action => execute(action) })

    async function execute(action: LabAction): Promise<LabActionResult> {
        const named = "world" in action ? action.world : null
        const world = named ? worlds.served(named) : null
        if (!world) throw err("WORLD_NOT_RUNNING", { detail: `${named ?? "that world"} is not running` })
        switch (action.kind) {
            case "world.reset":
                await world.ask({ type: "reset" })
                return { at: Date.now(), world: world.name, action: action, result: "every body back at its placement, at rest" }
            case "world.pace":
                await world.ask({ type: "pace", pace: action.pace })
                return { at: Date.now(), world: world.name, action: action, result: `pace ${action.pace.kind === "scaled" ? `× ${action.pace.factor}` : action.pace.kind}` }
            default:
                throw err("WORLD_REFUSED", { detail: `Atrium does not support ${action.kind}` })
        }
    }

    /**
     * Which world a caller meant. Named: that one, started if it is not up —
     * an address naming a world is what brings it to life. Unnamed: the one
     * already running, and a refusal if that is not exactly one.
     */
    async function intended(name: string | undefined): Promise<string> {
        if (!name) return worlds.only()
        await worlds.start(name)
        return name
    }

    return {
        library: library,
        async state(): Promise<LabState> {
            const problem = binary.problem()
            const live = worlds.state()
            return {
                id: "atrium",
                title: "Atrium",
                controls: live.length > 0 ? [...CONTROLS] : [],
                controlProblem: live.length > 0 ? null : "no world is running",
                problem: problem,
                worlds: problem ? [] : await worlds.list(),
                running: live,
                bodies: worlds.each().flatMap(world => world.bodies.list()),
                halted: null,
                notices: [...notices],
                leases: worlds.each().flatMap(world => world.bodies.leases()),
                bridge: await binary.state(),
            }
        },
        start: (input: { name: string }): Promise<RunningWorld> => worlds.start(input.name),
        stop: (input?: { name: string }): Promise<void> => (input ? worlds.stop(input.name) : worlds.stopAll()),
        async restart(input?: { name: string }): Promise<void> {
            const name = input?.name ?? worlds.only()
            await worlds.stop(name)
            await worlds.start(name)
        },
        logs(input?: { lines?: number }): { server: string[] } {
            return { server: worlds.log(null, input?.lines ?? 200) }
        },
        act: interventions.act,
        history: interventions.history,
        bridge: { state: binary.state, build: binary.build },
        /**
         * Atrium has no scenarios yet. Said, not answered with an empty list:
         * "this world has none" and "this lab cannot" are different facts, and
         * a surface that cannot tell them apart shows the wrong one.
         */
        scenarios: (): Promise<string[]> => { throw err("WORLD_REFUSED", { detail: "Atrium has no scenarios yet — connect to a world itself: world://localhost/atrium/<world>" }) },
        runs: {
            start: (): Promise<ScenarioRun> => { throw err("WORLD_REFUSED", { detail: "Atrium has no scenarios to run yet" }) },
            get: (): Promise<ScenarioRun> => { throw err("WORLD_REFUSED", { detail: "Atrium has no runs yet" }) },
            list: (): Promise<ScenarioRun[]> => { throw err("WORLD_REFUSED", { detail: "Atrium has no runs yet" }) },
            cancel: (): Promise<void> => { throw err("WORLD_REFUSED", { detail: "Atrium has no runs yet" }) },
        },
        bodies: {
            list: (): BodyInfo[] => worlds.each().flatMap(world => world.bodies.list()),
            /** A body placed for anyone to wear, in the world named — or the one running, if only one is. */
            add: async (input?: { body?: string; world?: string }): Promise<BodyInfo> =>
                worlds.bodies(await intended(input?.world)).add(input),
            /** The body the agent's address asked for, in the world it named — started here if it was not already up. */
            lease: async (input: LeaseInput): Promise<Embodiment> => {
                if (input.scenario) throw err("WORLD_REFUSED", { detail: "Atrium has no scenarios yet — connect to the world itself: world://localhost/atrium/<world>" })
                return worlds.bodies(await intended(input.world)).lease(input)
            },
            /** A lease belongs to one world; which, is found rather than asked for. */
            release: async (id: string): Promise<void> => {
                const held = worlds.each().find(world => world.bodies.leases().some((lease: Lease) => lease.id === id))
                if (!held) throw err("WORLD_LEASE_UNKNOWN", { detail: id })
                await held.bodies.release(id)
            },
        },
        /** Daemon shutdown: every world closed, every mind told. */
        dispose: () => worlds.stopAll(),
    }
}

export type AtriumLabT = ReturnType<typeof AtriumLab>

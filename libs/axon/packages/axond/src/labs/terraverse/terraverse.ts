import { join } from "node:path"
import { err } from "@arcforge/err"
import { Interventions } from "../interventions"
import { Processes } from "../processes"
import type { BodyInfo, Embodiment, LabAction, LabActionResult, LabState, Lease, LeaseInput, Notice, RunningWorld, ScenarioRun } from "../types"
import { Servers } from "./servers"
import { Terra } from "./terra"
import { Worlds } from "./worlds"

export type TerraverseLabOpts = {
    /** The lab's state folder: its process ledger, its interventions. */
    root: string
    /** Which build of axond this is: which terra it runs (see Terra). */
    build: "production" | "development"
    /** The `terra` to run; see Terra. */
    terra?: string
}

/**
 * TerraverseLab — Terraverse: a player's body, in a whole planet.
 *
 * Its worlds are the player's own, the game's Play list (terra says which),
 * and as many are served at once as are asked for, each as `terra serve
 * --world <name> --world-contract` run over the world contract. An agent's
 * address names the server; it is started if it is not already up, and a
 * player's body is placed in it and worn over the body contract, through the
 * bridge terra serves.
 *
 * A world the player opened in the game is attached to instead, by its address
 * (`terra attach`): spoken for the same way, never stopped from here.
 *
 * A pure orchestrator: `Worlds` owns what is running, each world owns its
 * own bodies, and this fans the lab's verbs across them.
 */
export function TerraverseLab(opts: TerraverseLabOpts) {
    const terra = Terra({ build: opts.build, ...(opts.terra ? { path: opts.terra } : {}) })
    const servers = Servers({ terra: terra })
    const processes = Processes({ ledger: join(opts.root, "pids.json") })
    const notices: Notice[] = []
    const notice = (text: string) => {
        notices.push({ at: new Date().toISOString(), text: text })
        if (notices.length > 100) notices.splice(0, notices.length - 100)
    }
    const worlds = Worlds({
        terra: terra,
        servers: servers,
        processes: processes,
        notice: (world, text) => notice(`${world}: ${text}`),
    })
    const interventions = Interventions({ root: opts.root, execute: action => execute(action) })

    /** Terraverse has no interventions yet: every one is refused, saying so. */
    async function execute(action: LabAction): Promise<LabActionResult> {
        throw err("WORLD_REFUSED", { detail: `Terraverse does not support ${action.kind} yet` })
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
        async state(): Promise<LabState> {
            const problem = terra.problem()
            const live = worlds.state()
            return {
                id: "terraverse",
                title: "Terraverse",
                controls: [],
                controlProblem: live.length > 0 ? "Terraverse has no interventions yet" : "no world is running",
                problem: problem,
                // terra says which worlds there are: without it there are none to show, and `problem` says why
                worlds: problem ? [] : await worlds.list(),
                running: live,
                bodies: worlds.each().flatMap(world => world.bodies.list()),
                halted: null,
                notices: [...notices],
                leases: worlds.each().flatMap(world => world.bodies.leases()),
                bridge: await terra.state(),
            }
        },
        start: (input: { name: string }): Promise<RunningWorld> => worlds.start(input.name),
        /** A world the player opened in the game, by its address: spoken for, so agents can go in. Stopping it lets it go. */
        attach: (input: { address: string }): Promise<RunningWorld> => worlds.attach(input.address),
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
        bridge: { state: terra.state, build: terra.build },
        /**
         * Terraverse has no scenarios yet. Said, not answered with an empty list:
         * "this world has none" and "this lab cannot" are different facts, and
         * a surface that cannot tell them apart shows the wrong one.
         */
        scenarios: (): Promise<string[]> => { throw err("WORLD_REFUSED", { detail: "Terraverse has no scenarios yet — connect to a server itself: world://localhost/terraverse/<server>" }) },
        runs: {
            start: (): Promise<ScenarioRun> => { throw err("WORLD_REFUSED", { detail: "Terraverse has no scenarios to run yet" }) },
            get: (): Promise<ScenarioRun> => { throw err("WORLD_REFUSED", { detail: "Terraverse has no runs yet" }) },
            list: (): Promise<ScenarioRun[]> => { throw err("WORLD_REFUSED", { detail: "Terraverse has no runs yet" }) },
            cancel: (): Promise<void> => { throw err("WORLD_REFUSED", { detail: "Terraverse has no runs yet" }) },
        },
        bodies: {
            list: (): BodyInfo[] => worlds.each().flatMap(world => world.bodies.list()),
            /** A body placed for anyone to wear, in the world named — or the one running, if only one is. */
            add: async (input?: { body?: string; world?: string }): Promise<BodyInfo> =>
                worlds.bodies(await intended(input?.world)).add(input),
            /** The body the agent's address asked for, in the world it named — started here if it was not already up. */
            lease: async (input: LeaseInput): Promise<Embodiment> => {
                if (input.scenario) throw err("WORLD_REFUSED", { detail: "Terraverse has no scenarios yet — connect to the server itself: world://localhost/terraverse/<server>" })
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

export type TerraverseLabT = ReturnType<typeof TerraverseLab>

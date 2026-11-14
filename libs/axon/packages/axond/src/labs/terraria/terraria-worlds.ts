import { existsSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { err } from "@arcforge/err"
import { Endpoint } from "../body/index"
import { Body } from "./body"
import { Pool } from "../pool/index"
import { Install } from "./install"
import { Interventions } from "../interventions"
import { Mod } from "./mod"
import { Processes } from "../processes"
import { Server } from "./server"
import type { WorldInfo, LabAction, LabState, RunningWorld, ScenarioRun } from "../types"

export type TerrariaWorldsOpts = {
    /** The lab's state folder — staged mods, body save folders, the process ledger. */
    root: string
    installDir?: string
    userDir?: string
}

/** Terraria's default multiplayer port — what "Join via IP" offers. */
const DEFAULT_PORT = 7777
const DEFAULT_PLAYERS = 16

/**
 * TerrariaWorlds — one running Terraria world, the warm bodies agents
 * occupy, and the mod they all load.
 *
 * What every engine shares — the warm-body pool, the endpoint a mind wears a
 * body through — is the labs' own; what is here is Terraria's.
 *
 * One world at a time, by decision rather than limitation: every leaf below
 * is per-world already, and allowing several is a change to this file alone.
 */
export function TerrariaWorlds(opts: TerrariaWorldsOpts) {
    const install = Install({ root: opts.root, ...(opts.installDir ? { installDir: opts.installDir } : {}), ...(opts.userDir ? { userDir: opts.userDir } : {}) })
    const processes = Processes({ ledger: install.lab.pids })
    const mod = Mod({ install: install })
    const server = Server({ install: install, processes: processes })
    const interventions = Interventions({ root: opts.root, execute: action => server.act(action) })
    const bodies = Pool({
        body: made => Body({ id: made.id, slot: made.slot, install: install, processes: processes }),
        world: () => server.current,
        start: input => start(input),
        // AxonT says what the body is and senses; the lab adds what the client renders into its display and plays
        // into its sound device.
        endpoint: body => Endpoint({
            bridge: body.bridge,
            screen: body.screen,
            audio: body.audio,
            dir: join(install.lab.bodies, body.id, "senses"),
            hearing: { channel: "/hearing", ...body.hearing },
            vision: { channel: "/vision" },
        }),
    })
    let reaped = false

    async function list(): Promise<WorldInfo[]> {
        if (!existsSync(install.worldsDir)) return []
        const names = (await readdir(install.worldsDir)).filter(name => name.endsWith(".wld"))
        return await Promise.all(names.map(async name => {
            const path = join(install.worldsDir, name)
            const info = await stat(path)
            return { name: basename(name, ".wld"), path: path, bytes: info.size, modifiedAt: info.mtime.toISOString() }
        }))
    }

    async function stop(): Promise<void> {
        let failure: unknown = null
        await bodies.stop().catch((cause: unknown) => { failure = cause })
        await server.stop()
        if (failure) throw failure
    }

    /**
     * One world, served. A Terraria server binds a port and loads one .wld,
     * so this lab runs exactly one at a time — asking for the one already up
     * gives it back, and asking for another refuses rather than swapping it
     * out from under whoever is in it.
     */
    async function start(input: { name: string; port?: number; players?: number }): Promise<RunningWorld> {
        const held = server.current
        if (held) {
            if (held.name === input.name) return held
            throw err("WORLD_ALREADY_RUNNING", { detail: `${held.name} is running, and Terraria serves one world at a time — stop it first`, context: { world: held.name } })
        }
        install.require()
        const path = install.worldPath(input.name)
        if (!existsSync(path)) throw err("WORLD_NOT_FOUND", { detail: path, context: { world: input.name } })
        if (!reaped) {
            const killed = processes.reap()
            if (killed.length > 0) console.log(`[worlds] reaped processes an earlier daemon left behind: ${killed.join(", ")}`)
            reaped = true
        }
        await mod.stage()
        await server.start({ name: input.name, path: path, port: input.port ?? DEFAULT_PORT, players: input.players ?? DEFAULT_PLAYERS })
        bodies.start()
        const started = server.current
        if (!started) throw err("WORLD_START_FAILED", { detail: `${input.name} was started but the lab does not see it running`, context: { world: input.name } })
        return started
    }

    return {
        list: list,

        /** Everything Fleet shows for this lab, in one read. */
        async state(): Promise<LabState> {
            const control = await server.control()
            return {
                id: "terraria",
                title: "Terraria",
                controls: control.ready ? ["teleport", "health", "spawn"] : [],
                controlProblem: control.problem,
                problem: install.problem(),
                worlds: await list(),
                running: server.current ? [server.current] : [],
                bodies: bodies.list(),
                halted: bodies.halted(),
                notices: bodies.notices(),
                leases: bodies.leases(),
                bridge: await mod.state(),
            }
        },

        start: start,
        stop: stop,

        /** Stop and start the running world — how a rebuilt mod reaches the server and every body. */
        async restart(): Promise<void> {
            const running = server.current
            if (!running) throw err("WORLD_NOT_RUNNING", { detail: "nothing to restart" })
            await stop()
            await start({ name: running.name, port: running.port })
        },

        /** The server's recent output. */
        logs(input?: { lines?: number }): { server: string[] } {
            return { server: server.log(input?.lines ?? 200) }
        },

        async act(action: LabAction) {
            if (action.kind !== "teleport" && action.kind !== "health" && action.kind !== "spawn") {
                throw new Error(`Terraria does not support ${action.kind}`)
            }
            if ("player" in action && !bodies.leases().some(lease => lease.identity === action.player))
                throw new Error(`No managed body is leased as '${action.player}'.`)
            return await interventions.act(action)
        },
        history: interventions.history,

        bridge: {
            state: mod.state,
            build: mod.build,
        },

        /** Terraria has no scenarios yet — said, not answered with an empty list. */
        scenarios: (): Promise<string[]> => { throw err("WORLD_REFUSED", { detail: "Terraria has no scenarios yet" }) },
        runs: {
            start: (): Promise<ScenarioRun> => { throw err("WORLD_REFUSED", { detail: "Terraria has no scenarios to run yet" }) },
            get: (): Promise<ScenarioRun> => { throw err("WORLD_REFUSED", { detail: "Terraria has no runs yet" }) },
            list: (): Promise<ScenarioRun[]> => { throw err("WORLD_REFUSED", { detail: "Terraria has no runs yet" }) },
            cancel: (): Promise<void> => { throw err("WORLD_REFUSED", { detail: "Terraria has no runs yet" }) },
        },
        bodies: {
            list: bodies.list,
            add: bodies.add,
            lease: bodies.lease,
            release: bodies.release,
        },

        /** What an agent is using here: its body, and — once it is in one — the world server. */

        /** Daemon shutdown: characters saved back, every process stopped. */
        dispose: stop,
    }
}

export type TerrariaWorldsT = ReturnType<typeof TerrariaWorlds>

import { join } from "node:path"
import { err } from "@arcforge/err"
import type { LabState, RunningWorld } from "../types"
import { Processes } from "../processes"
import { Pool } from "../pool/index"
import { Interventions } from "../interventions"
import { Endpoint } from "../body/index"
import { Body } from "./body"
import { Install } from "./install"
import { Jvm } from "./jvm"
import { Launch } from "./launch"
import { Mod } from "./mod"
import { Server } from "./server"
import { Worlds } from "./worlds"
import { CONTROLS, Operator, controls } from "./operator"
import { Places } from "./places"
import { Studio } from "./studio"
import { Runs } from "./runs"
import type { LauncherT } from "../../launcher/index"

export type MinecraftWorldsOpts = { root: string; launcher: LauncherT; modSource?: string; java?: string; prism?: string; template?: string }

/**
 * MinecraftWorlds — one running Fabric world, the warm bodies agents occupy,
 * and the mod they all load.
 *
 * One world at a time, by decision rather than limitation: every leaf below is
 * per-world already, and allowing several is a change to this file alone.
 */
export function MinecraftWorlds(opts: MinecraftWorldsOpts) {
    const install = Install({ root: opts.root, ...(opts.modSource ? { modSource: opts.modSource } : {}) })
    const processes = Processes({ ledger: install.lab.pids })
    const launch = Launch({ ...(opts.prism ? { prism: opts.prism } : {}), ...(opts.template ? { template: opts.template } : {}) })
    const worlds = Worlds({ managed: install.worlds, root: opts.root, prismGame: launch.gameDir })
    const places = Places({ directory: name => worlds.path({ name: name }) })
    const jvm = Jvm({ prism: launch.prism, ...(opts.java ? { java: opts.java } : {}) })
    const mod = Mod({ install: install })
    const operator = Operator({ worlds: worlds })
    const server = Server({ install: install, processes: processes, jvm: jvm, operator: operator, worlds: worlds })
    const interventions = Interventions({ root: opts.root, execute: action => server.act(action) })
    const bodies = Pool({
        body: made => Body({ id: made.id, slot: made.slot, install: install, processes: processes, launch: launch, jvm: jvm }),
        world: () => server.current,
        start: input => start(input),
        /*
         * Sized for Minecraft, not inherited from Terraria.
         *
         * A client here wants 2GB of heap and saturates several cores while it
         * class-loads and meshes chunks, so two is what an ordinary machine
         * commits. `settleMs` is the one that was actually costing us: booting
         * a spare on top of a body that had just entered the world starved the
         * in-world client past the server's keepalive window and it was dropped
         * with "Timed out" — twice, at exactly 45s, with every process healthy.
         */
        limits: { spares: 1, max: 2, settleMs: 90_000 },
        // Minecraft's bodies speak the body contract: the mod says what the body is and senses; the lab adds its
        // screen and its sound, which the client renders into the lab's display and sound device.
        endpoint: body => Endpoint({
            bridge: body.bridge,
            screen: body.screen,
            audio: body.audio,
            dir: join(install.lab.bodies, body.id, "senses"),
            hearing: { channel: "/hearing", ...body.hearing },
            vision: { channel: "/vision" },
        }),
    })
    const studio = Studio({ root: install.lab.root, processes: processes, launch: launch, jvm: jvm, mod: mod, stagedMod: install.lab.stagedMod, worlds: install.worlds })
    let reaped = false

    /** Everything the lab is serving stopped: its bodies, then its server. */
    async function halt(): Promise<void> {
        const cleanup = await Promise.allSettled([bodies.stop()])
        const errors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : [])
        try {
            await server.stop()
        } catch (cause) {
            errors.push(cause)
        }
        if (errors.length > 0) throw new AggregateError(errors, "Could not fully stop the Minecraft lab")
    }

    /** Serves a world — the lab's own, or a run's copy of one at `level` — and starts its bodies. */
    async function serve(input: { name: string; level?: string; env?: Record<string, string> }): Promise<void> {
        if (!reaped) {
            const killed = processes.reap()
            if (killed.length > 0) console.log(`[minecraft] reaped processes an earlier daemon left behind: ${killed.join(", ")}`)
            reaped = true
        }
        await mod.stage()
        await server.start({ name: input.name, port: 25565, players: 16, ...(input.level ? { level: input.level } : {}), ...(input.env ? { env: input.env } : {}) })
        bodies.start()
    }

    const runs = Runs({
        root: join(opts.root, "runs"),
        worlds: worlds,
        launcher: opts.launcher,
        host: {
            current: () => server.current,
            serve: serve,
            stop: halt,
            leases: () => bodies.leases(),
            state: async () => {
                const control = await server.control()
                if (!control.state) throw new Error(control.problem ?? "the run's server is not answering its operator")
                return { players: control.state.players, run: control.state.run }
            },
            begin: player => operator.begin(player),
        },
    })

    /** Refuses while a run is using the lab: its world must not be pulled out from under it. */
    function free(verb: string): void {
        const run = runs.active()
        if (run) throw err("WORLD_ALREADY_RUNNING", { detail: `run ${run} is using the lab; cancel it (axon world --cancel ${run}) before you ${verb}` })
    }

    async function stop(): Promise<void> {
        free("stop the world")
        await halt()
    }

    /**
     * One world, served. A Minecraft server binds a port and loads one save,
     * so this lab runs exactly one at a time — asking for the one already up
     * gives it back, and asking for another refuses rather than swapping it
     * out from under whoever is in it.
     */
    async function start(input: { name: string; port?: number; players?: number }): Promise<RunningWorld> {
        const held = server.current
        if (held) {
            if (held.name === input.name) return held
            throw err("WORLD_ALREADY_RUNNING", { detail: `${held.name} is running, and Minecraft serves one world at a time — stop it first`, context: { world: held.name } })
        }
        free("start a world")
        const discovered = (await worlds.list()).find(world => world.name === input.name)
        if (!discovered && input.name !== "Axon_Town") throw new Error(`World ${input.name} is not in the lab; create or import it first`)
        if (discovered?.source !== undefined && discovered.source !== "lab") {
            throw new Error(`${input.name} is a personal save; add it to the lab before starting it`)
        }
        await mod.stage()
        await server.start({ name: input.name, port: input.port ?? 25565, players: input.players ?? 16 })
        bodies.start()
        const started = server.current
        if (!started) throw err("WORLD_START_FAILED", { detail: `${input.name} was started but the lab does not see it running`, context: { world: input.name } })
        return started
    }

    return {
        studio: studio,
        runs: { start: runs.start, get: runs.get, list: runs.list, cancel: runs.cancel },
        worlds: {
            list: worlds.list,
            import: worlds.import,
            scenarios: worlds.scenarios,
            places: places,
            async remove(input: { name: string }): Promise<string> {
                if (server.current?.name === input.name) throw new Error(`Stop ${input.name} before removing it from the lab`)
                return await worlds.remove(input)
            },
        },
        async act(action: import("../types").LabAction) {
            if (!controls(action)) throw new Error(`Minecraft does not support ${action.kind}`)
            if (server.current?.state !== "running" || server.current.name !== action.world) {
                throw new Error(`World ${action.world} is not running`)
            }
            return await interventions.act(action)
        },
        history: interventions.history,
        async state(): Promise<LabState> {
            const control = await server.control()
            return {
                id: "minecraft",
                title: "Minecraft",
                controls: control.ready ? [...CONTROLS] : [],
                controlProblem: control.problem,
                ...(control.state ? { conditions: control.state.conditions, players: control.state.players } : {}),
                // The server's problems first, then the client's: a world can
                // run before any body can, and a lab that reported only the
                // server would say "ready" to a machine that cannot boot a
                // client. Terraria folds its body requirements in the same way.
                problem: (await server.problem()) ?? launch.problem(),
                worlds: await worlds.list(),
                running: server.current ? [server.current] : [],
                bodies: bodies.list(),
                halted: bodies.halted(),
                notices: bodies.notices(),
                leases: bodies.leases(),
                bridge: await mod.state(),
            }
        },
        async bootstrap(input: { acceptEula: boolean; name: string; port?: number; players?: number }): Promise<void> {
            await server.bootstrap(input)
        },
        start: start,
        stop: stop,
        async restart(): Promise<void> {
            const running = server.current
            if (!running) throw err("WORLD_NOT_FOUND", { detail: "no Minecraft world is running" })
            await stop()
            await this.start({ name: running.name, port: running.port })
        },
        logs(input?: { lines?: number }): { server: string[] } { return { server: server.log(input?.lines ?? 200) } },
        bridge: { state: mod.state, build: mod.build },
        bodies: {
            list: bodies.list,
            add: bodies.add,
            lease: bodies.lease,
            release: bodies.release,
        },

        /** What an agent is using here: its body, and — once it is in one — the world server. */

        /** Daemon shutdown: everyone out, every process stopped. */
        async dispose(): Promise<void> {
            // Halted rather than stopped: the daemon is going, a run with it, and its own cleanup finds nothing left to stop.
            const cleanup = await Promise.allSettled([studio.stop(), halt()])
            const errors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : [])
            if (errors.length > 0) throw new AggregateError(errors, "Could not fully dispose the Minecraft lab")
        },
    }
}

export type MinecraftWorldsT = ReturnType<typeof MinecraftWorlds>

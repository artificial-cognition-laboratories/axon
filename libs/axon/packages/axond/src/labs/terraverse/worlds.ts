import { err } from "@arcforge/err"
import type { ProcessesT } from "../processes"
import type { RunningWorld, WorldInfo } from "../types"
import { Bodies, type BodiesT } from "./bodies"
import { Served, type ServedT } from "./served"
import type { ServersT } from "./servers"
import type { TerraT } from "./terra"

export type WorldsOpts = {
    terra: TerraT
    servers: ServersT
    processes: ProcessesT
    /** Something a person should know, said against the world it happened in. */
    notice: (world: string, text: string) => void
}

/** How often each running world is swept: dead agents' bodies taken back, who wears what read again. */
const SWEEP_MS = 2_000

/** One world of the lab, running: what serves it, where it came from, and the bodies in it. */
type Running = {
    served: ServedT
    /** Its folder, in the player's profile. */
    path: string
    bodies: BodiesT
    sweeping: ReturnType<typeof setInterval>
}

/**
 * Worlds — every world this lab is serving, beside each other.
 *
 * One world per name, each its own `terra serve --world-contract` process
 * with its own bodies and its own sweep. Asking for a world already
 * running gives that one back untouched — which is how a second agent joins
 * the world a first is already in, rather than restarting it underneath.
 *
 * Callers never hold a `Running`: they name a world and this dispatches.
 */
export function Worlds(opts: WorldsOpts) {
    const running = new Map<string, Running>()
    /** Named while its process is being spawned, so a second start waits rather than making two. */
    const starting = new Map<string, Promise<RunningWorld>>()
    let reaped = false

    /** Every server the lab has, whether running or not. */
    function all(): Promise<WorldInfo[]> {
        return opts.servers.list()
    }

    function describe(name: string, world: Running): RunningWorld {
        return {
            name: name,
            path: world.path,
            state: "running",
            host: "127.0.0.1",
            port: world.served.port,
            // Bodies are leased with tokens of their own; the world has no password.
            password: "",
            players: world.bodies.list().filter(body => body.state === "embodied").map(body => body.identity ?? body.id),
            pid: world.served.pid,
            startedAt: world.served.startedAt,
            // watched by joining it from the game (`view`, a terra:// address), not by a viewer here
            observers: [],
        }
    }

    async function serve(name: string): Promise<RunningWorld> {
        if (!reaped) {
            const killed = opts.processes.reap()
            if (killed.length > 0) opts.notice(name, `reaped worlds an earlier daemon left behind: ${killed.join(", ")}`)
            reaped = true
        }
        const found = (await all()).find(world => world.name === name)
        if (!found) throw err("WORLD_NOT_FOUND", { detail: `there's no world ${name} in the player's Play list — \`terra worlds\` lists them` })
        const served = await Served({
            processes: opts.processes,
            terra: opts.terra.path(),
            name: name,
            heard: said => opts.notice(name, said.text),
        })
        const bodies = Bodies({ world: served, notice: text => opts.notice(name, text) })
        const sweeping = setInterval(() => {
            bodies.sweep().catch(cause => opts.notice(name, `sweeping ${name}: ${cause instanceof Error ? cause.message : String(cause)}`))
            if (served.ended && running.get(name)?.served === served) {
                opts.notice(name, `${name} ended on its own: ${served.ended}`)
                void stop(name)
            }
        }, SWEEP_MS)
        const world: Running = { served: served, path: found.path, bodies: bodies, sweeping: sweeping }
        running.set(name, world)
        return describe(name, world)
    }

    /** One world stopped: its sweep ended, its bodies' minds told, its process closed. */
    async function stop(name: string): Promise<void> {
        const world = running.get(name)
        if (!world) return
        running.delete(name)
        clearInterval(world.sweeping)
        world.bodies.clear(`${name} stopped`)
        await world.served.close()
    }

    return {
        list: all,

        /** The worlds running now, and the ones still starting, as a person sees them. */
        state(): RunningWorld[] {
            const live = [...running.entries()].map(([name, world]) => describe(name, world))
            const pending: RunningWorld[] = [...starting.keys()]
                .filter(name => !running.has(name))
                .map(name => ({ name: name, path: "", state: "starting", host: "127.0.0.1", port: 0, password: "", players: [], pid: null, startedAt: new Date().toISOString(), observers: [] }))
            return [...live, ...pending]
        },

        /**
         * `name` served, beside whatever else is. Already running: that one,
         * untouched. Already starting: the same start, awaited — two agents
         * naming one world boot it once.
         */
        async start(name: string): Promise<RunningWorld> {
            const held = running.get(name)
            if (held) return describe(name, held)
            const pending = starting.get(name)
            if (pending) return await pending
            const begun = serve(name).finally(() => starting.delete(name))
            starting.set(name, begun)
            return await begun
        },

        stop: stop,

        /** Every world stopped — the daemon going down, or a person stopping the lab. */
        async stopAll(): Promise<void> {
            await Promise.all([...running.keys()].map(stop))
        },

        /** The bodies of one world, named. A world that is not running is said so here, once, for every verb that needs one. */
        bodies(name: string): BodiesT {
            const world = running.get(name)
            if (!world) {
                throw err("WORLD_NOT_RUNNING", {
                    detail: running.size === 0
                        ? `${name} is not running — an agent's address starts it, or start it from the Worlds view`
                        : `${name} is not running; Terraverse is serving ${[...running.keys()].join(", ")}`,
                    context: { world: name },
                })
            }
            return world.bodies
        },

        /**
         * The one world running, for a caller that named none — the old
         * shorthand's meaning. None running, or several, and it refuses:
         * guessing which world an agent meant is how two agents end up in
         * different worlds believing they share one.
         */
        only(): string {
            const names = [...running.keys()]
            if (names.length === 1) return names[0]!
            if (names.length === 0) throw err("WORLD_NOT_RUNNING", { detail: "no Terraverse server is running, and this address names none to start — say which: world://localhost/terraverse/<server>" })
            throw err("WORLD_ALREADY_RUNNING", { detail: `Terraverse is serving ${names.join(", ")} — say which to join: world://localhost/terraverse/<server>` })
        },

        /** Every world's bodies, in one list, each saying which world it is in. */
        each(): Array<{ name: string; bodies: BodiesT }> {
            return [...running.entries()].map(([name, world]) => ({ name: name, bodies: world.bodies }))
        },

        /** What serves `name`, for the lab's own verbs — null when it is not running. */
        served(name: string): ServedT | null {
            return running.get(name)?.served ?? null
        },

        /** Every world's log, or one's. */
        log(name: string | null, lines: number): string[] {
            if (name) return running.get(name)?.served.log(lines) ?? []
            return [...running.values()].flatMap(world => world.served.log(lines))
        },
    }
}

export type WorldsT = ReturnType<typeof Worlds>

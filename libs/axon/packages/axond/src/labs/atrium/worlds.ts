import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { ProcessesT } from "../processes"
import type { RunningWorld, WorldInfo } from "../types"
import type { BinaryT } from "./binary"
import { Bodies, type BodiesT } from "./bodies"
import type { LibraryT } from "./library"
import { Served, type ServedT } from "./served"

export type WorldsOpts = {
    binary: BinaryT
    library: LibraryT
    processes: ProcessesT
    /** The lab's state folder: each world's senses live under it. */
    root: string
    /** Something a person should know, said against the world it happened in. */
    notice: (world: string, text: string) => void
}

/** How often each running world is swept: dead agents' bodies taken back, who wears what read again. */
const SWEEP_MS = 2_000

/** One world of the lab, running: what serves it, where it came from, and the bodies in it. */
type Running = {
    served: ServedT
    /** Where it lives in the library, as the library said when it was started. */
    path: string
    bodies: BodiesT
    sweeping: ReturnType<typeof setInterval>
}

/**
 * Worlds — every world this lab is serving, beside each other.
 *
 * One world per name, each its own `atrium serve` process with its own
 * senses, its own bodies, and its own sweep. Asking for a world already
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

    /** Every world the library holds, whether running or not. */
    async function all(): Promise<WorldInfo[]> {
        const built = (await opts.binary.state()).built?.at ?? new Date(0).toISOString()
        const entries = await opts.library.list()
        return entries.filter(entry => entry.kind === "world").map(entry => ({
            name: entry.name,
            path: entry.path ?? `${entry.name} (built into Atrium)`,
            // A built-in world is as new as the Atrium it is built into.
            modifiedAt: entry.path ? new Date(Bun.file(join(entry.path, "world.json")).lastModified).toISOString() : built,
            source: "lab" as const,
        }))
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
            observers: [{ id: "scene", kind: "geometry", label: "the whole world", url: world.served.ready.view }],
        }
    }

    async function serve(name: string): Promise<RunningWorld> {
        if (!reaped) {
            const killed = opts.processes.reap()
            if (killed.length > 0) opts.notice(name, `reaped worlds an earlier daemon left behind: ${killed.join(", ")}`)
            reaped = true
        }
        await opts.binary.stage()
        const found = (await all()).find(world => world.name === name)
        if (!found) throw err("WORLD_NOT_FOUND", { detail: `Atrium's library has no world ${name} — import one first` })

        const senses = join(opts.root, "senses", name)
        await rm(senses, { recursive: true, force: true })
        await mkdir(senses, { recursive: true })
        const served = await Served({
            processes: opts.processes,
            binary: opts.binary.path,
            library: opts.library.args,
            senses: senses,
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
                        : `${name} is not running; Atrium is serving ${[...running.keys()].join(", ")}`,
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
            if (names.length === 0) throw err("WORLD_NOT_RUNNING", { detail: "no Atrium world is running, and this address names none to start — say which: world://localhost/atrium/<world>" })
            throw err("WORLD_ALREADY_RUNNING", { detail: `Atrium is serving ${names.join(", ")} — say which to join: world://localhost/atrium/<world>` })
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

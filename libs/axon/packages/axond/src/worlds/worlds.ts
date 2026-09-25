import { existsSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { err } from "@arcforge/err"
import { Bodies } from "./bodies"
import { Install } from "./install"
import { Mod } from "./mod"
import { Processes } from "./processes"
import { Server } from "./server"
import type { WorldFile, WorldsState } from "./types"

export type WorldsOpts = {
    /** The lab's state folder — staged mods, body save folders, the process ledger. */
    root: string
    installDir?: string
    userDir?: string
}

/** Terraria's default multiplayer port — what "Join via IP" offers. */
const DEFAULT_PORT = 7777
const DEFAULT_PLAYERS = 16

/**
 * Worlds — the lab: one running Terraria world, the warm bodies agents
 * occupy, and the mod they all load.
 *
 * Terraria is the only world engine, so this is written for it directly. A
 * general "world engine" seam would be designed from one example, which is
 * how a wrong abstraction gets its shape; the second engine will say what the
 * seam is.
 *
 * One world at a time, by decision rather than limitation: every leaf below
 * is per-world already, and allowing several is a change to this file alone.
 */
export function Worlds(opts: WorldsOpts) {
    const install = Install({ root: opts.root, ...(opts.installDir ? { installDir: opts.installDir } : {}), ...(opts.userDir ? { userDir: opts.userDir } : {}) })
    const processes = Processes({ ledger: install.lab.pids })
    const mod = Mod({ install: install })
    const server = Server({ install: install, processes: processes })
    const bodies = Bodies({ install: install, processes: processes, world: () => server.current })
    let reaped = false

    async function list(): Promise<WorldFile[]> {
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
        await bodies.stop().catch(cause => { failure = cause })
        await server.stop()
        if (failure) throw failure
    }

    async function start(input: { name: string; port?: number; players?: number }): Promise<void> {
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
    }

    return {
        list: list,

        /** Everything the Worlds view shows, in one read. */
        async state(): Promise<WorldsState> {
            return {
                problem: install.problem(),
                worlds: await list(),
                running: server.current,
                bodies: bodies.list(),
                halted: bodies.halted(),
                notices: bodies.notices(),
                leases: bodies.leases(),
                mod: await mod.state(),
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

        mod: {
            state: mod.state,
            build: mod.build,
        },

        bodies: {
            list: bodies.list,
            add: bodies.add,
            lease: bodies.lease,
            release: bodies.release,
        },

        /** Daemon shutdown: characters saved back, every process stopped. */
        dispose: stop,
    }
}

export type WorldsT = ReturnType<typeof Worlds>

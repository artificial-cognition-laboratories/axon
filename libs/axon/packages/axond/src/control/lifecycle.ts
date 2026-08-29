import { spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { err } from "@arcforge/err"
import type { DaemonPaths, DaemonStarted, DaemonStatus } from "../../types/index"

type LifecycleOpts = {
    paths: DaemonPaths
    /** This build's version, stamped into `status`. */
    version: string
    /** Absolute path to the executable a detached start spawns. */
    entrypoint: string
    /**
     * The interpreter that runs it.
     *
     * Defaults to whatever is running this — right for the CLI, wrong for the
     * VS Code extension host, whose `execPath` is Electron and which cannot
     * run a `.ts` entrypoint. A host that is not Bun supplies the Bun it wants
     * used, and finding one is its problem rather than this leaf's.
     */
    runtime?: string
}

/**
 * Lifecycle — is a daemon running, and start or stop one.
 *
 * ── Why the pidfile is not the source of truth ──────────────────────────────
 *
 * It is a HINT. A process killed with -9 leaves one behind, so a reader that
 * trusted it would report a daemon that is gone — and `up` would refuse to
 * start because of a file. Every read therefore probes the pid, and a stale
 * record is cleared where it is found. Same posture the running/ registry
 * takes, and for the same reason: the process table is the fact, the file is
 * a convenience.
 *
 * ── Owned here, not by the server ───────────────────────────────────────────
 *
 * `up`/`down`/`status` are what a CLI calls when NO daemon is running, so they
 * cannot live behind the socket. That is also what lets `axond up` and `axon
 * daemon up` be the same code rather than two implementations of "spawn it and
 * wait for a socket".
 */
export function Lifecycle(opts: LifecycleOpts) {
    /** How long a fresh daemon has to bind its socket before the start is called failed. */
    const READY_TIMEOUT_MS = 5_000
    const POLL_MS = 50

    function livePid(): number | null {
        if (!existsSync(opts.paths.pid)) return null

        const raw = Number.parseInt(readFileSync(opts.paths.pid, "utf-8").trim(), 10)
        if (!Number.isFinite(raw)) {
            rmSync(opts.paths.pid, { force: true })
            return null
        }

        try {
            // Signal 0 probes without delivering — the pid exists and is ours.
            process.kill(raw, 0)
            return raw
        } catch {
            rmSync(opts.paths.pid, { force: true })
            return null
        }
    }

    return {
        /** The pid of a live daemon, or null. Clears a stale record as it looks. */
        pid: livePid,

        status(): DaemonStatus {
            const pid = livePid()
            if (pid === null) return { running: false }

            const started = existsSync(opts.paths.pid)
                ? Math.floor((Date.now() - Number(statMtime(opts.paths.pid))) / 1000)
                : 0

            return {
                running: true,
                pid: pid,
                uptime: Math.max(0, started),
                version: opts.version,
                socket: opts.paths.socket,
            }
        },

        /**
         * Record this process as the running daemon.
         *
         * Called by the SERVER once it is listening, never by a client: the
         * pidfile means "a daemon is accepting connections", and writing it
         * before the socket exists would make `up` report success to a client
         * that then cannot connect.
         */
        claim(): void {
            mkdirSync(opts.paths.root, { recursive: true })
            writeFileSync(opts.paths.pid, String(process.pid), "utf-8")
        },

        /** Release the record. Best-effort — a crash leaves it for the next reader to reap. */
        release(): void {
            rmSync(opts.paths.pid, { force: true })
        },

        /**
         * Start a detached daemon and wait until it is listening.
         *
         * Detached and fully redirected: the daemon must outlive the terminal
         * that started it, and a child sharing its parent's stdio keeps the
         * parent's pipe open — which makes a shell hang after the command
         * returns.
         *
         * Waits for the SOCKET rather than for the process: a spawned pid says
         * the binary launched, not that it is ready, and reporting success on
         * the former is how a caller's first request races the bind.
         */
        async up(): Promise<DaemonStarted> {
            const existing = livePid()
            if (existing !== null) {
                return { pid: existing, socket: opts.paths.socket, already: true }
            }

            mkdirSync(opts.paths.root, { recursive: true })

            /**
             * `node:child_process`, not `Bun.spawn`.
             *
             * This is called from the CLI (Bun) and from the VS Code extension
             * host (Node), and a Bun-only spawn simply is not there in the
             * second. One code path for both beats a runtime check choosing
             * between two — the same reason the client posts over `node:http`.
             */
            const out = openSync(opts.paths.log, "a")
            const child = spawn(opts.runtime ?? process.execPath, [opts.entrypoint, "serve"], {
                stdio: ["ignore", out, out],
                // Survives the shell it was started from — the whole point.
                detached: true,
            })
            child.unref()

            const deadline = Date.now() + READY_TIMEOUT_MS
            while (Date.now() < deadline) {
                if (existsSync(opts.paths.socket) && livePid() !== null) {
                    return { pid: child.pid ?? 0, socket: opts.paths.socket, already: false }
                }
                await new Promise(resolve => setTimeout(resolve, POLL_MS))
            }

            throw err("DAEMON_START_FAILED", {
                detail: `axond did not bind ${opts.paths.socket} within ${READY_TIMEOUT_MS / 1000}s — see ${opts.paths.log}`,
                context: { socket: opts.paths.socket, log: opts.paths.log },
            })
        },

        /**
         * Stop the running daemon. Returns false when none was.
         *
         * SIGTERM, not SIGKILL: the daemon has agents to shut down and a
         * socket to unlink, and killing it outright leaves both — a stale
         * socket that the next `up` has to clear, and orphaned agent
         * processes with no supervisor.
         */
        down(): boolean {
            const pid = livePid()
            if (pid === null) return false

            process.kill(pid, "SIGTERM")
            return true
        },
    }
}

/** Pidfile mtime as a start time. Written once at claim, so it IS the start. */
function statMtime(path: string): number {
    return Bun.file(path).lastModified
}

export type LifecycleT = ReturnType<typeof Lifecycle>

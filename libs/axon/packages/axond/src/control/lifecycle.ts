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
     * Asked before replacing a daemon from an older build. True replaces it.
     *
     * A seam rather than a policy baked in here, because the answer depends on
     * what the daemon is holding: a restart disposes every agent it supervises,
     * which is fine on an idle machine and destructive on a busy one. This leaf
     * knows versions and pids, not what is running — the caller does.
     *
     * Absent means replace, which is the right default for a leaf used by
     * scripts and tests. The interactive path supplies one.
     */
    onStale?(input: { pid: number; running: string; expected: string }): boolean | Promise<boolean>
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

    /**
     * What the pidfile records: a pid, and the build that wrote it.
     *
     * The version is on the RECORD rather than asked for over the socket
     * because the question "is the running daemon current" has to be
     * answerable before a client dials one — `up` is what a CLI calls when it
     * does not yet know whether anything is listening.
     *
     * A file written by an older build has no version line, which reads as
     * "unknown" and therefore as stale. That is the correct answer for it:
     * a daemon that predates this field predates everything after it too.
     */
    function readRecord(): { pid: number; version: string | null } | null {
        if (!existsSync(opts.paths.pid)) return null

        const [pidLine, versionLine] = readFileSync(opts.paths.pid, "utf-8").trim().split("\n")
        const raw = Number.parseInt((pidLine ?? "").trim(), 10)
        if (!Number.isFinite(raw)) {
            rmSync(opts.paths.pid, { force: true })
            return null
        }

        try {
            process.kill(raw, 0)
        } catch {
            rmSync(opts.paths.pid, { force: true })
            return null
        }

        return { pid: raw, version: versionLine?.trim() || null }
    }

    function livePid(): number | null {
        if (!existsSync(opts.paths.pid)) return null

        const raw = Number.parseInt(readFileSync(opts.paths.pid, "utf-8").trim().split("\n")[0] ?? "", 10)
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
                // The RUNNING daemon's build, read off its own record — not
                // `opts.version`, which is whatever CLI happened to ask. That
                // made the one diagnostic for this problem confirm the wrong
                // thing: `daemon status` reported the caller's version, so a
                // daemon left behind by an update looked current.
                version: readRecord()?.version ?? "unknown",
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
            // The build that is actually serving, so a later client can tell a
            // current daemon from one left over across an update.
            writeFileSync(opts.paths.pid, `${process.pid}\n${opts.version}`, "utf-8")
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
            const existing = readRecord()
            if (existing !== null) {
                /**
                 * A daemon from an OLDER BUILD is not a running daemon.
                 *
                 * `axon update` replaces the CLI and never touches the
                 * supervisor, so without this the new CLI talks to whatever
                 * was already listening — indefinitely, since `up` is called
                 * before every agent command and returned `already` on the
                 * strength of a live pid alone. A user's daemon survived
                 * every release until they happened to restart it themselves,
                 * and nothing ever told them to: the CLI dispatched verbs the
                 * old process had never heard of and got DAEMON_NOT_WIRED, or
                 * worse, got old BEHAVIOUR silently.
                 *
                 * Replacing it is the whole fix. It is NOT free: the daemon's
                 * shutdown disposes every agent it supervises, so a restart
                 * ends them. That is why the caller decides — `opts.onStale`
                 * is asked, and a surface with live agents can refuse and say
                 * so rather than having them killed by a command the user
                 * thought was unrelated.
                 */
                /**
                 * Matching, or NO EXPECTATION to match against.
                 *
                 * A caller that supplies no version (the client's `ensure`,
                 * which knows a path and not a build) cannot judge staleness
                 * and must not try: treating "" as a mismatch would restart a
                 * perfectly good daemon on every single command.
                 */
                if (!opts.version || existing.version === opts.version) {
                    return { pid: existing.pid, socket: opts.paths.socket, already: true }
                }

                const replace = (await opts.onStale?.({
                    pid: existing.pid,
                    running: existing.version ?? "unknown",
                    expected: opts.version,
                })) ?? true
                if (!replace) {
                    throw err("DAEMON_STALE", {
                        detail: `the running daemon is ${existing.version ?? "an older build"}, this CLI is ${opts.version}`
                            + " — stop the agents it supervises, or run `axon daemon restart`",
                        context: { pid: existing.pid, running: existing.version ?? "unknown", expected: opts.version },
                    })
                }

                process.kill(existing.pid, "SIGTERM")
                // Wait for the pidfile to clear rather than sleeping a guess:
                // the old daemon releases it on the way down, and starting
                // before it has would race two processes onto one socket.
                const until = Date.now() + READY_TIMEOUT_MS
                while (readRecord() !== null && Date.now() < until) {
                    await Bun.sleep(POLL_MS)
                }
                rmSync(opts.paths.pid, { force: true })
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
                /**
                 * The child is TOLD where to live. It never re-derives it.
                 *
                 * `daemonPaths()` reads NODE_ENV to choose `~/.axon` or
                 * `~/.axon-dev`. That works in-process, but the bundler INLINES
                 * NODE_ENV as a literal — so in a published CLI
                 * `process.env.NODE_ENV` is undefined at runtime and there is
                 * nothing to forward. The daemon is a separate bundle with its
                 * own inlining, so it answered "development" while the client
                 * that spawned it dialled "production", and the client waited
                 * out its timeout on a socket that was never going to appear.
                 *
                 * `AXON_DAEMON_DIR` is the existing override and takes
                 * precedence over the NODE_ENV branch, so handing the child the
                 * parent's ALREADY-RESOLVED root removes the second derivation
                 * entirely. One answer, computed once, by the process that
                 * knows which distribution it is.
                 */
                env: {
                    ...process.env,
                    AXON_DAEMON_DIR: opts.paths.root,
                },
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

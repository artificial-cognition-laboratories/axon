import { randomUUID } from "node:crypto"
import { splitCommand, type ShellDecision } from "@arcforge/types"
import { capsuleFault } from "./fault"
import { spawn as nodeSpawn } from "node:child_process"
import type { CapsuleCommand, LiveProcHandle, ProcRunOptions, ProcRunResult, ProcSpawnOptions } from "../../types"
import { wrapEntry, type ProcEntry } from "../sandbox/procs/handle"
import type { MediatorT } from "./mediator"
import type { InProcWireT as SandboxWireT } from "../inproc/emitter"

type ProcsOpts = {
    mediator: MediatorT
    wire: SandboxWireT
}

/**
 * SandboxProcs — owns every real child process the capsule manages.
 *
 * Two distinct operations, one mediation path:
 *   spawn() — tracked, live handle, for long-running/background work.
 *             Reachable from the host (proc:spawn over the wire) and from
 *             sandboxed code (process.spawn(), installed by Scope).
 *   run()   — blocking, but still observable — spawn, mirror lifecycle and
 *             incremental output, await completion, return the result.
 *             It is ephemeral work rather than a durable background handle.
 */
export function SandboxProcs(opts: ProcsOpts) {
    const { mediator, wire } = opts
    const children = new Map<string, ReturnType<typeof nodeSpawn>>()
    const runChildren = new Map<string, ReturnType<typeof nodeSpawn>>()
    const entries = new Map<string, ProcEntry>()
    const subscribers = new Map<string, Set<(line: string) => void>>()
    // procIds killed while still mid-mediation — checked once the await
    // resolves so a kill() that races the spawn is never silently lost.
    const killedBeforeSpawn = new Set<string>()

    function notify(key: string, data: string) {
        const set = subscribers.get(key)
        if (!set?.size) return
        for (const line of data.split(/\r?\n/)) {
            for (const cb of [...set]) cb(line)
        }
    }

    /**
     * Announce that a spawn has SETTLED — launched with a pid, or refused.
     *
     * Separate from markExited because the two are genuinely different
     * transitions: a process can settle as running and exit an hour later.
     * Every path out of mediation calls exactly one of these, which is what
     * makes `started` un-hangable.
     */
    function markStarted(entry: ProcEntry, pid: number) {
        entry.pid = pid
        entry.status = "running"
        const set = subscribers.get(entry.procId + ":start")
        if (set) for (const cb of [...set]) cb("")
    }

    function markExited(entry: ProcEntry, code: number | undefined, error?: string) {
        // A spawn refused before it ever launched settles BOTH: it will never
        // be running, so anything awaiting `started` has its answer now.
        // Without this a denied spawn left `started` pending forever — the
        // same silent hang the promise exists to remove.
        const wasPending = entry.status === "pending"
        entry.status = "exited"
        if (code !== undefined) entry.exitCode = code
        if (error !== undefined) entry.error = error
        entry.endedAt = Date.now()
        if (wasPending) {
            const startSet = subscribers.get(entry.procId + ":start")
            if (startSet) for (const cb of [...startSet]) cb("")
        }
        const set = subscribers.get(entry.procId + ":exit")
        if (set) for (const cb of [...set]) cb("")
    }

    function impl(procId: string) {
        return {
            kill: () => kill(procId),
            stdin: (data: string) => stdin(procId, data),
            subscribe(key: string, cb: (line: string) => void) {
                let set = subscribers.get(key)
                if (!set) {
                    set = new Set()
                    subscribers.set(key, set)
                }
                set.add(cb)
                return () => set!.delete(cb)
            },
        }
    }

    /**
     * Spawn a managed child process. Returns immediately with a live handle,
     * same ergonomics as the host's Procs.spawn() — mediation and the real
     * spawn happen in the background; a denial marks the entry exited
     * (code -1) and emits capsule:proc:denied rather than ever running.
     */
    function spawn(command: string, spawnOpts?: ProcSpawnOptions & { procId?: string }): LiveProcHandle {
        const procId = spawnOpts?.procId ?? randomUUID()
        const entry: ProcEntry = {
            procId,
            kind: "managed",
            command,
            // PENDING, not running: mediation and the OS spawn are still
            // ahead of us. Stamping "running" here was a claim nobody had
            // made yet — and since a bare `process.spawn(...)` serialises the
            // handle immediately, that fiction is exactly what the model read.
            status: "pending",
            stdout: [],
            stderr: [],
            startedAt: Date.now(),
            ...(spawnOpts?.cwd ? { cwd: spawnOpts.cwd } : {}),
        }
        entries.set(procId, entry)

        void mediateAndSpawn(entry, command, spawnOpts)

        return wrapEntry(entry, impl(procId))
    }

    async function mediateAndSpawn(entry: ProcEntry, command: string, spawnOpts?: ProcSpawnOptions): Promise<void> {
        const procId = entry.procId

        // Two gates, because spawning is two privileges: may this PROGRAM run
        // at all (the same question `run` asks), and may a long-lived child be
        // held. Either refusing is a refusal.
        const decision = await mediator.shell(splitCommand(command), command)
        const allowed = decision.verdict === "allow"
            && await mediator.check("shell.spawn", command, [command])

        if (killedBeforeSpawn.has(procId)) {
            killedBeforeSpawn.delete(procId)
            wire.emit("process:proc:denied", { procId, command, error: capsuleFault("CAPSULE_PROC_DENIED", { message: "killed before it could spawn", context: { procId, command } }) })
            markExited(entry, -1, "killed before it could spawn")
            return
        }

        if (!allowed) {
            // The REASON travels, for the same reason run() carries one: a
            // model told "denied" can only guess, and a model told "shells are
            // off" can rewrite the call.
            const reason = decision.verdict === "allow"
                ? "denied by policy: shell.spawn does not permit holding a background process"
                : shellDenial(decision)
            wire.emit("process:proc:denied", { procId, command, error: capsuleFault("CAPSULE_PROC_DENIED", { message: reason, context: { procId, command } }) })
            markExited(entry, -1, reason)
            return
        }

        const child = nodeSpawn(command, {
            shell: true,
            cwd: spawnOpts?.cwd,
            env: spawnOpts?.env ? { ...process.env, ...spawnOpts.env } : process.env,
            stdio: ["pipe", "pipe", "pipe"],
            /**
             * Its OWN process group, exactly as `run` does — and for a
             * stronger reason.
             *
             * `shell: true` means the child we hold is `/bin/sh -c "<command>"`,
             * not the command. A bare `child.kill()` therefore signals the
             * SHELL: the shell dies, the real workload is orphaned onto init,
             * and it survives kill(), interrupt() and shutdown() alike. A
             * `sleep 30` outlived `capsule.shutdown()` by its full duration,
             * and an agent that spawns ambient work every session leaked one
             * per session with nothing reporting it.
             *
             * A group leader lets killTree() signal the whole tree, so the
             * thing the agent actually asked for is the thing that dies.
             */
            detached: hasProcessGroups(),
        })

        if (child.pid === undefined) {
            wire.emit("process:proc:denied", { procId, command, error: capsuleFault("CAPSULE_PROC_DENIED", { message: "spawn failed", context: { procId, command } }) })
            markExited(entry, -1, "spawn failed")
            return
        }

        entry.cwd = spawnOpts?.cwd ?? process.cwd()
        // The pid is real and the child is live — this is the ONE transition
        // that makes the handle's `running` true rather than assumed.
        markStarted(entry, child.pid)
        wire.emit("process:proc:start", { procId, pid: child.pid, command, cwd: entry.cwd, kind: "managed" })

        if (killedBeforeSpawn.has(procId)) {
            killedBeforeSpawn.delete(procId)
            child.kill()
            // Let the real "exit" listener (registered below) report the actual
            // exit code — killing here doesn't skip past it, just triggers it.
        } else {
            children.set(procId, child)
        }

        child.stdout?.on("data", (chunk: Buffer) => {
            const data = chunk.toString()
            entry.stdout.push(data)
            notify(procId, data)
            wire.emit("process:proc:stdout", { procId, data })
        })
        child.stderr?.on("data", (chunk: Buffer) => {
            const data = chunk.toString()
            entry.stderr.push(data)
            wire.emit("process:proc:stderr", { procId, data })
        })
        // A managed child can fail after spawn returns (exec failure, IPC
        // break) and never emit "exit". Without this the span stays open
        // forever and the entry never leaves the live process list.
        child.on("error", cause => {
            children.delete(procId)
            markExited(entry, -1)
            wire.emit("process:proc:failed", {
                procId,
                error: capsuleFault("CAPSULE_PROC_FAILED", {
                    message: cause.message,
                    context: { procId, command },
                    cause,
                }),
                durationMs: Date.now() - entry.startedAt,
            })
        })
        child.on("exit", code => {
            children.delete(procId)
            markExited(entry, code ?? -1)
            wire.emit("process:proc:complete", { procId, code: code ?? -1, durationMs: Date.now() - entry.startedAt })
        })
    }

    /**
     * process.run() — blocking but observable. It retains the ergonomic
     * result promise while emitting the same process lifecycle/output stream
     * as spawn(), marked kind="run", so a long command is never a silent gap.
     */
    async function run(command: string, runOpts?: ProcRunOptions, signal?: AbortSignal): Promise<ProcRunResult> {
        if (signal?.aborted) throw abortError()
        const decision = await mediator.shell(splitCommand(command), command)
        const allowed = decision.verdict === "allow"
        if (signal?.aborted) throw abortError()
        if (!allowed) {
            // The REASON, not just "denied": a model that tried `sh -c` can
            // rewrite the call if it is told that shells are off, and cannot if
            // it is told only that something was denied.
            return { ok: false, exitCode: -1, stdout: "", stderr: "", err: shellDenial(decision) }
        }

        return new Promise<ProcRunResult>((resolve, reject) => {
            const procId = randomUUID()
            const startedAt = Date.now()
            const child = nodeSpawn(command, {
                shell: true,
                cwd: runOpts?.cwd,
                env: runOpts?.env ? { ...process.env, ...runOpts.env } : process.env,
                stdio: ["pipe", "pipe", "pipe"],
                // A blocking shell command is command-owned. Its entire
                // process group must die when the enclosing capsule run does.
                detached: hasProcessGroups(),
            })

            if (child.pid === undefined) {
                resolve({ ok: false, exitCode: -1, stdout: "", stderr: "", err: "spawn failed" })
                return
            }

            runChildren.set(procId, child)

            /**
             * A blocking run is TRACKED too.
             *
             * The host-side mirror used to build these rows from the wire —
             * `proc:start` created an entry whether it came from spawn() or
             * run(), so both appeared in the process tree. That mirror is gone
             * and this registry answers `list()` directly, so a run that
             * registers nothing is a command the tree cannot see: observable
             * while it streams, invisible the moment anyone asks what ran.
             */
            const entry: ProcEntry = {
                procId,
                kind: "run",
                command,
                pid: child.pid,
                cwd: runOpts?.cwd ?? process.cwd(),
                status: "running",
                stdout: [],
                stderr: [],
                startedAt,
            }
            entries.set(procId, entry)

            wire.emit("process:proc:start", {
                procId,
                pid: child.pid,
                command,
                cwd: runOpts?.cwd ?? process.cwd(),
                kind: "run",
            })

            let stdout = ""
            let stderr = ""
            let settled = false
            const settle = (fn: () => void) => {
                if (settled) return
                settled = true
                signal?.removeEventListener("abort", onAbort)
                fn()
            }
            const onAbort = () => {
                killTree(child)
                settle(() => reject(abortError()))
            }
            child.stdout?.on("data", (chunk: Buffer) => {
                const data = chunk.toString()
                stdout += data
                entry.stdout.push(data)
                wire.emit("process:proc:stdout", { procId, data })
            })
            child.stderr?.on("data", (chunk: Buffer) => {
                const data = chunk.toString()
                stderr += data
                entry.stderr.push(data)
                wire.emit("process:proc:stderr", { procId, data })
            })

            // The span broke rather than settled: the child errored without
            // ever producing an exit code, so :complete's `code` would be a
            // fabricated -1. :failed says what actually happened.
            child.on("error", cause => {
                runChildren.delete(procId)
                wire.emit("process:proc:failed", {
                    procId,
                    error: capsuleFault("CAPSULE_PROC_FAILED", {
                        message: cause.message,
                        context: { procId, command },
                        cause,
                    }),
                    durationMs: Date.now() - startedAt,
                })
                settle(() => resolve({ ok: false, exitCode: -1, stdout, stderr, err: cause.message }))
            })
            child.on("exit", code => {
                runChildren.delete(procId)
                markExited(entry, code ?? -1)
                wire.emit("process:proc:complete", { procId, code: code ?? -1, durationMs: Date.now() - startedAt })
                settle(() => resolve({ ok: code === 0, exitCode: code ?? -1, stdout, stderr }))
            })

            signal?.addEventListener("abort", onAbort, { once: true })
            if (signal?.aborted) onAbort()

            if (runOpts?.input !== undefined) child.stdin?.write(runOpts.input)
            child.stdin?.end()
        })
    }

    function kill(procId: string): void {
        const runChild = runChildren.get(procId)
        if (runChild) {
            killTree(runChild)
            return
        }
        const child = children.get(procId)
        if (child) {
            // killTree, not child.kill(): with `shell: true` the handle is the
            // shell, and signalling it alone orphans the command it wraps.
            killTree(child)
            return
        }
        // No live child yet — spawn is still mid-mediation. Record the intent
        // so mediateAndSpawn() checks it once the await resolves, instead of
        // silently losing a kill() that raced the spawn.
        const entry = entries.get(procId)
        if (entry?.status === "pending") killedBeforeSpawn.add(procId)
    }

    function stdin(procId: string, data: string): void {
        const child = children.get(procId)
        if (!child?.stdin?.writable) {
            wire.emit("process:proc:stdin:error", { procId, error: capsuleFault("CAPSULE_PROC_STDIN_FAILED", { message: "process not running or stdin closed", context: { procId } }) })
            return
        }
        child.stdin.write(data)
    }

    // Host-initiated path: proc:spawn/proc:kill/proc:stdin over the wire.
    wire.onCommand((cmd: CapsuleCommand) => {
        if (cmd.type === "proc:spawn") {
            spawn(cmd.command, { cwd: cmd.cwd, env: cmd.env, procId: cmd.procId })
        } else if (cmd.type === "proc:kill") {
            kill(cmd.procId)
        } else if (cmd.type === "proc:stdin") {
            stdin(cmd.procId, cmd.data)
        }
    })

    return {
        /** In-sandbox + host path: tracked, live handle. */
        spawn,

        /** In-sandbox only path: blocking, observable, never throws except cancellation. */
        run,

        /**
         * Every managed child, live.
         *
         * The host-side mirror used to answer this by folding wire events into
         * its own copy of the tree. In one heap there is no mirror and no copy
         * — this registry IS the tree, so the handles are the same objects the
         * spawner holds rather than a reconstruction that can fall behind.
         */
        list(): LiveProcHandle[] {
            return [...entries.values()].map(entry => wrapEntry(entry, impl(entry.procId)))
        },

        /** One child by id, or undefined if it never existed here. */
        get(procId: string): LiveProcHandle | undefined {
            const entry = entries.get(procId)
            return entry ? wrapEntry(entry, impl(procId)) : undefined
        },

        /** Kill every managed child — called on capsule shutdown. */
        killAll(): void {
            for (const child of children.values()) killTree(child)
            for (const child of runChildren.values()) killTree(child)
        },
    }
}

/**
 * Whether this OS gives a spawned child its own process GROUP.
 *
 * One named fact, read once, rather than three `process.platform` checks that
 * happen to agree. They encode a single decision — POSIX gives a detached
 * child its own group, so the whole tree can be signalled with `kill(-pid)`;
 * Windows has no equivalent, so only the direct child can be killed and its
 * grandchildren are orphaned.
 *
 * Named and exported because it is otherwise UNTESTABLE: the Windows branch
 * never executes on Linux CI, so a change to it ships unreviewed. With the
 * fact isolated, `killTree` can be exercised for both shapes on any machine —
 * which is the only way that branch gets reviewed at all.
 */
export function hasProcessGroups(platform: NodeJS.Platform = process.platform): boolean {
    return platform !== "win32"
}

function abortError(): Error {
    const error = new Error("process.run aborted")
    error.name = "AbortError"
    return error
}

export function killTree(
    child: Pick<ReturnType<typeof nodeSpawn>, "pid" | "kill">,
    /**
     * Injected so BOTH shapes are testable on one machine. The Windows branch
     * is the one that cannot be exercised on CI, and it is also the one whose
     * failure is invisible: `child.kill()` reaches the direct child only, so a
     * process that spawned its own children leaves them running.
     */
    groups: boolean = hasProcessGroups(),
    signal: (pid: number, sig: NodeJS.Signals) => void = process.kill,
): void {
    try {
        if (groups && child.pid) signal(-child.pid, "SIGKILL")
        else child.kill()
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!message.includes("ESRCH") && !message.includes("process not found")) throw err
    }
}

export type SandboxProcsT = ReturnType<typeof SandboxProcs>

/** A shell denial as a sentence the model can act on. */
function shellDenial(decision: ShellDecision): string {
    if (decision.reason === "raw-shell") {
        return "denied by policy: a raw shell is not permitted (shell.raw is off) — call the program directly rather than through sh -c"
    }
    if (decision.reason === "not-allowed") return `denied by policy: "${decision.program}" is not in shell.allow`
    if (decision.reason === "denied") return `denied by policy: "${decision.program}" is in shell.deny`
    if (decision.reason === "args") return `denied by policy: those arguments to "${decision.program}" are not permitted`
    return "denied by policy"
}

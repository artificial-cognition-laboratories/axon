import { randomUUID } from "node:crypto"
import { capsuleFault } from "./fault"
import { spawn as nodeSpawn } from "node:child_process"
import type { CapsuleCommand, LiveProcHandle, ProcRunOptions, ProcRunResult, ProcSpawnOptions } from "../../types"
import { wrapEntry, type ProcEntry } from "../sandbox/procs/handle"
import type { MediatorT } from "./mediator"
import type { SandboxWireT } from "./wire"

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

    function markExited(entry: ProcEntry, code: number | undefined) {
        entry.status = "exited"
        if (code !== undefined) entry.exitCode = code
        entry.endedAt = Date.now()
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
            status: "running",
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

        const allowed = await mediator.check("process.spawn", command, [command])

        if (killedBeforeSpawn.has(procId)) {
            killedBeforeSpawn.delete(procId)
            wire.emit("capsule:proc:denied", { procId, command, error: capsuleFault("CAPSULE_PROC_DENIED", { message: "killed before it could spawn", context: { procId, command } }) })
            markExited(entry, -1)
            return
        }

        if (!allowed) {
            wire.emit("capsule:proc:denied", { procId, command, error: capsuleFault("CAPSULE_PROC_DENIED", { message: "denied by policy", context: { procId, command } }) })
            markExited(entry, -1)
            return
        }

        const child = nodeSpawn(command, {
            shell: true,
            cwd: spawnOpts?.cwd,
            env: spawnOpts?.env ? { ...process.env, ...spawnOpts.env } : process.env,
            stdio: ["pipe", "pipe", "pipe"],
        })

        if (child.pid === undefined) {
            wire.emit("capsule:proc:denied", { procId, command, error: capsuleFault("CAPSULE_PROC_DENIED", { message: "spawn failed", context: { procId, command } }) })
            markExited(entry, -1)
            return
        }

        entry.pid = child.pid
        entry.cwd = spawnOpts?.cwd ?? process.cwd()
        wire.emit("capsule:proc:start", { procId, pid: child.pid, command, cwd: entry.cwd, kind: "managed" })

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
            wire.emit("capsule:proc:stdout", { procId, data })
        })
        child.stderr?.on("data", (chunk: Buffer) => {
            const data = chunk.toString()
            entry.stderr.push(data)
            wire.emit("capsule:proc:stderr", { procId, data })
        })
        // A managed child can fail after spawn returns (exec failure, IPC
        // break) and never emit "exit". Without this the span stays open
        // forever and the entry never leaves the live process list.
        child.on("error", cause => {
            children.delete(procId)
            markExited(entry, -1)
            wire.emit("capsule:proc:failed", {
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
            wire.emit("capsule:proc:complete", { procId, code: code ?? -1, durationMs: Date.now() - entry.startedAt })
        })
    }

    /**
     * process.run() — blocking but observable. It retains the ergonomic
     * result promise while emitting the same process lifecycle/output stream
     * as spawn(), marked kind="run", so a long command is never a silent gap.
     */
    async function run(command: string, runOpts?: ProcRunOptions, signal?: AbortSignal): Promise<ProcRunResult> {
        if (signal?.aborted) throw abortError()
        const allowed = await mediator.check("process.run", command, [command])
        if (signal?.aborted) throw abortError()
        if (!allowed) {
            return { ok: false, exitCode: -1, stdout: "", stderr: "", err: "denied by policy" }
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
                detached: process.platform !== "win32",
            })

            if (child.pid === undefined) {
                resolve({ ok: false, exitCode: -1, stdout: "", stderr: "", err: "spawn failed" })
                return
            }

            runChildren.set(procId, child)
            wire.emit("capsule:proc:start", {
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
                wire.emit("capsule:proc:stdout", { procId, data })
            })
            child.stderr?.on("data", (chunk: Buffer) => {
                const data = chunk.toString()
                stderr += data
                wire.emit("capsule:proc:stderr", { procId, data })
            })

            // The span broke rather than settled: the child errored without
            // ever producing an exit code, so :complete's `code` would be a
            // fabricated -1. :failed says what actually happened.
            child.on("error", cause => {
                runChildren.delete(procId)
                wire.emit("capsule:proc:failed", {
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
                wire.emit("capsule:proc:complete", { procId, code: code ?? -1, durationMs: Date.now() - startedAt })
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
            child.kill()
            return
        }
        // No live child yet — spawn is still mid-mediation. Record the intent
        // so mediateAndSpawn() checks it once the await resolves, instead of
        // silently losing a kill() that raced the spawn.
        const entry = entries.get(procId)
        if (entry?.status === "running") killedBeforeSpawn.add(procId)
    }

    function stdin(procId: string, data: string): void {
        const child = children.get(procId)
        if (!child?.stdin?.writable) {
            wire.emit("capsule:proc:stdin:error", { procId, error: capsuleFault("CAPSULE_PROC_STDIN_FAILED", { message: "process not running or stdin closed", context: { procId } }) })
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

        /** Kill every managed child — called on capsule shutdown. */
        killAll(): void {
            for (const child of children.values()) child.kill()
            for (const child of runChildren.values()) killTree(child)
        },
    }
}

function abortError(): Error {
    const error = new Error("process.run aborted")
    error.name = "AbortError"
    return error
}

function killTree(child: ReturnType<typeof nodeSpawn>): void {
    try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill()
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!message.includes("ESRCH") && !message.includes("process not found")) throw err
    }
}

export type SandboxProcsT = ReturnType<typeof SandboxProcs>

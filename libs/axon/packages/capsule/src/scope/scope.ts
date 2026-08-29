/**
 * Scope — the ONE place model-facing globals are installed in the sandbox.
 *
 * The `process` global is augmented with two shell-execution verbs node
 * does not have:
 *   process.run(cmd)    — blocking: run a command, await the full result.
 *                          Never throws; failures are ok: false. Runs inline
 *                          in the capsule's own subprocess — this is not TS
 *                          eval, it is bash, same primitive as Bun's $.
 *   process.spawn(cmd)  — detached: returns a LiveProcHandle immediately for
 *                          a tracked, long-running child process.
 *
 * Most of `process` (env, cwd, platform, pid, argv, ...) retains Node
 * behavior. Lifecycle and transport capabilities are different: exit is
 * blocked, and stdout/stderr writes are redirected into correlated console
 * events because real stdout is the capsule's private JSONL protocol wire.
 *
 * Rule: we only ADD/replace these specific verbs. Node-owned members (.on/
 * .emit/...) are never shadowed — sandbox code and our own bootstrap rely
 * on their real semantics, and sharing node's emitter would let sandboxed
 * code forge capsule protocol events. The bus stays internal to the
 * sandbox program; sandbox code emits nothing and observes nothing.
 */

import type { LiveProcHandle, ProcRunOptions, ProcRunResult, ProcSpawnOptions } from "../../types"
import type { AxonCapsuleHandle } from "@arcforge/types"

export type ScopeOpts = {
    /** Blocking shell execution — the real owner of process.run(). */
    run(command: string, opts?: ProcRunOptions): Promise<ProcRunResult>
    /** Detached shell execution — the real owner of process.spawn(). */
    spawn(command: string, opts?: ProcSpawnOptions): LiveProcHandle
    write(level: "log" | "error", data: string | Uint8Array): boolean
    /** The capsule-safe Axon facade installed as globalThis.axon. */
    axon: AxonCapsuleHandle
    /**
     * Is model code executing right now?
     *
     * False means the write belongs to the HOST and must reach the real
     * stream. Absent keeps the old unconditional capture, which is correct for
     * a process the capsule owns entirely.
     */
    capture?: () => boolean
    /**
     * Replace an existing installation rather than refusing.
     *
     * Set by the in-process owner on a reload. See the guard for why the
     * default is to refuse.
     */
    rebind?: boolean
}

/** The real Node process.exit — call this for the capsule's own shutdown, never sandboxed code's. */
export const realExit = process.exit.bind(process)

/** Augment the process global. Called once by the sandbox bootstrap. */
export function installScope(opts: ScopeOpts): void {
    const proc = process as NodeJS.Process & {
        run?: ScopeOpts["run"]
        spawn?: ScopeOpts["spawn"]
    }

    /**
     * Installed ONCE per process — unless the caller is explicitly rebinding.
     *
     * These are global mutations, and the guard exists because two sandboxes
     * sharing one process would fight over `process.run`: model code in one
     * would shell out through the other's mediator, under the other's policy.
     * Subprocess-side that could never happen, so a second call was always a
     * wiring fault and throwing was right.
     *
     * In-process it is routine. A reload replaces the sandbox — new policy,
     * new mediator, same process — and the verbs must point at the new one or
     * every subsequent `process.run` is gated by a policy the user has already
     * replaced. `rebind` says "I am the owner, swapping myself"; without it
     * the guard still catches the case it was written for.
     */
    if ((proc.run || proc.spawn) && !opts.rebind) {
        throw new Error("CAPSULE_SCOPE_VIOLATION: installScope() must be called exactly once")
    }

    proc.run = opts.run
    proc.spawn = opts.spawn

    // The one Axon-owned global besides the process verbs. It is a
    // capsule-safe facade: local activity plus trusted host-backed methods.
    ;(globalThis as { axon?: AxonCapsuleHandle }).axon = opts.axon

    /**
     * Console capture, scoped to a RUNNING COMMAND.
     *
     * Subprocess-side these were replaced outright: stdout was the protocol
     * wire, so nothing else in that process was allowed near it and every
     * write belonged to model code by definition.
     *
     * In one heap that is false and destructive. The host shares this stdout —
     * the TUI renders through it, a test runner reports through it — so
     * hijacking it unconditionally silenced everything the process wrote while
     * an agent happened to exist. It looked like tests interfering with each
     * other; it was the agent swallowing their output.
     *
     * So the redirect applies only while a command is executing, and falls
     * through to the real stream otherwise. `capture()` answers "is model code
     * running right now", which is precisely the question the original replace
     * assumed away.
     */
    const realStdout = proc.stdout.write.bind(proc.stdout)
    const realStderr = proc.stderr.write.bind(proc.stderr)

    proc.stdout.write = ((data: string | Uint8Array, ...rest: unknown[]) =>
        opts.capture?.() === false
            ? (realStdout as (d: string | Uint8Array, ...r: unknown[]) => boolean)(data, ...rest)
            : opts.write("log", data)) as typeof proc.stdout.write

    proc.stderr.write = ((data: string | Uint8Array, ...rest: unknown[]) =>
        opts.capture?.() === false
            ? (realStderr as (d: string | Uint8Array, ...r: unknown[]) => boolean)(data, ...rest)
            : opts.write("error", data)) as typeof proc.stderr.write

    /**
     * `process.exit` guarded, scoped to a RUNNING COMMAND — same reasoning as
     * the streams above, and the same bug it fixes.
     *
     * Subprocess-side the capsule owns the whole process, so every exit()
     * belonged to model code and refusing unconditionally was right.
     * In-process the HOST shares this global: the TUI's own shutdown path
     * calls process.exit(), and an unconditional guard turned every ctrl+C
     * into a CAPSULE_SCOPE_VIOLATION thrown out of the host's exit handler.
     * The capsule was refusing the host permission to close its own process.
     *
     * `capture()` answers "is model code running right now" — the question
     * the unconditional replace assumed away. False means this is the host
     * exiting, which is always allowed.
     */
    process.exit = ((code?: number) => {
        if (opts.capture?.() === false) return realExit(code)
        throw new Error("CAPSULE_SCOPE_VIOLATION: sandboxed code cannot call process.exit() — the capsule owns its subprocess lifecycle")
    }) as never
}

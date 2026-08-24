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
}

/** The real Node process.exit — call this for the capsule's own shutdown, never sandboxed code's. */
export const realExit = process.exit.bind(process)

/** Augment the process global. Called once by the sandbox bootstrap. */
export function installScope(opts: ScopeOpts): void {
    const proc = process as NodeJS.Process & {
        run?: ScopeOpts["run"]
        spawn?: ScopeOpts["spawn"]
    }

    if (proc.run || proc.spawn) {
        // Subprocess-side: throw plain. The manager codes it at the wire boundary.
        throw new Error("CAPSULE_SCOPE_VIOLATION: installScope() must be called exactly once")
    }

    proc.run = opts.run
    proc.spawn = opts.spawn

    // The one Axon-owned global besides the process verbs. It is a
    // capsule-safe facade: local activity plus trusted host-backed methods.
    ;(globalThis as { axon?: AxonCapsuleHandle }).axon = opts.axon

    proc.stdout.write = ((data: string | Uint8Array) => opts.write("log", data)) as typeof proc.stdout.write
    proc.stderr.write = ((data: string | Uint8Array) => opts.write("error", data)) as typeof proc.stderr.write

    process.exit = (() => {
        throw new Error("CAPSULE_SCOPE_VIOLATION: sandboxed code cannot call process.exit() — the capsule owns its subprocess lifecycle")
    }) as never
}

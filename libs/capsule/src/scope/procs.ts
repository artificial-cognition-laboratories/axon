/**
 * Procs (sandbox-side) — the real owner of managed child processes.
 *
 * Lives inside the sandbox program. spawn() is policy-gated (proc rule),
 * returns the real LiveProcHandle, and emits proc:spawned/stdout/stderr/exit
 * over the internal bus so the host mirror stays true.
 *
 * The host-side Procs client (src2 root, TODO) is the event-built mirror of
 * this — same LiveProcHandle type, two projections.
 *
 * TODO(migration): port the implementation from src/process/proc-manager.ts
 * (spawn/kill/stdin, output ring buffers, waitFor/watch subscriptions) when
 * the sandbox program moves into src2. This file fixes the boundary and the
 * contract now so scope.ts and the wire have a stable seam to build against.
 */

import type { LiveProcHandle } from "../../types"

export type SandboxProcsT = {
    spawn(command: string, opts?: { cwd?: string }): LiveProcHandle
    kill(procId: string): Promise<void>
    stdin(procId: string, data: string): void
    get(procId: string): LiveProcHandle | undefined
    list(): LiveProcHandle[]
}

export function SandboxProcs(): SandboxProcsT {
    throw new Error("SandboxProcs is not wired yet — sandbox program migration pending")
}

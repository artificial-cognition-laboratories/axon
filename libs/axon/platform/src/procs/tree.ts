import type { AxonEventMap, CapsuleEventMap } from "@arcforge/types"

/**
 * One process in an agent's tree, as any surface renders it.
 *
 * `main` is the agent's own runtime — the root every other row hangs under.
 * Everything else is something the agent spawned: `managed` for a live handle
 * (process.spawn), `run` for a blocking command (process.run).
 *
 * "down" is distinct from "exited": an exited process reported a code, a
 * process that is down was alive when its agent stopped reporting. A remote
 * agent that goes unreachable leaves rows in exactly that state, and calling
 * them "exited" would invent an exit nobody observed.
 *
 * "pending" is the fourth: a spawn that was asked for but has not yet been
 * mediated or launched. No row reaches this fold in that state — the log only
 * learns about a process once `process:proc:start` carries a real pid — but
 * the type admits it because a LIVE handle does, and a surface rendering both
 * a folded row and a live one must not have two vocabularies for one
 * lifecycle.
 */
export type ProcNode = {
    procId: string
    kind: "main" | "managed" | "run"
    command: string
    pid?: number
    cwd?: string
    status: "pending" | "running" | "exited" | "down"
    exitCode?: number
    startedAt: number
    endedAt?: number
    /** The agent's own runtime — parent of every other row. */
    main?: boolean
    /** Last buffered output lines (stdout+stderr merged), oldest first. */
    output: string[]
}

/**
 * The envelope shape this fold reads.
 *
 * Deliberately structural rather than `AxonKernelEvent`: capsule events are
 * classified INTO kernelLog at runtime (isKernelEvent matches "capsule:"), but
 * `AxonKernelEvent` is typed from AxonKernelEventMap alone, so the declared
 * type of that array does not admit the events it actually holds. Reading the
 * union of everything (AxonEventMap) and narrowing on `type` here keeps this
 * honest without asserting the log is something it is not.
 *
 * That mismatch is worth fixing at the source — AxonKernelEvent should be
 * derived from what isKernelEvent() accepts — but widening it touches every
 * kernelLog consumer and does not belong in this change.
 */
export type ProcLogEvent = {
    [K in keyof AxonEventMap]: { type: K; at?: number; data: AxonEventMap[K] }
}[keyof AxonEventMap]

/** How many output lines a row retains. Bounded: a watcher left running for a day is not a memory leak. */
const OUTPUT_MAX = 200

/**
 * Fold a session's event log into a process tree.
 *
 * PURE — events in, tree out. No handles, no live objects, no source
 * awareness. That is the entire point: the TUI used to build this by reaching
 * through `runtime.kernel.userland` into the live capsule handle, which works
 * only for an agent running in this process. A deployment's process list was
 * therefore always empty, and the composable said so
 * ("processes are local-only ... its own capsule's business").
 *
 * The session log already carried everything needed. `process:proc:start`,
 * `:complete` and `:failed` are DURABLE events (only the byte streams are in
 * CAPSULE_TRANSIENT_EVENTS), so a remote agent's mirrored log holds its
 * process history — nothing was ever reading it. Folding the log instead of
 * reading a handle makes local and remote the same code path, which is what
 * Fleet already does for its flame graph.
 *
 * Byte streams are transient, so `output` fills only from live bus events. A
 * mirrored remote log yields correct rows with empty output, which is honest:
 * that output was never persisted anywhere to recover.
 */
export function procTree(
    events: readonly ProcLogEvent[],
    opts?: {
        /** The agent's own runtime, when the caller knows it — becomes the `main` row. */
        main?: { pid?: number; status: "running" | "exited" | "down"; startedAt?: number }
    },
): ProcNode[] {
    const byId = new Map<string, ProcNode>()

    for (const event of events) {
        switch (event.type) {
            case "process:proc:start": {
                const data = event.data as { procId: string; pid: number; command: string; cwd: string; kind: "managed" | "run" }
                byId.set(data.procId, {
                    procId: data.procId,
                    kind: data.kind,
                    command: data.command,
                    pid: data.pid,
                    cwd: data.cwd,
                    status: "running",
                    startedAt: typeof event.at === "number" ? event.at : Date.now(),
                    output: [],
                })
                break
            }
            case "process:proc:complete": {
                const data = event.data as { procId: string; code: number }
                const node = byId.get(data.procId)
                if (!node) break
                node.status = "exited"
                node.exitCode = data.code
                if (typeof event.at === "number") node.endedAt = event.at
                break
            }
            case "process:proc:failed": {
                // The span BROKE rather than settled — the child never produced
                // an exit code. Recording a fabricated one would claim an
                // observation nobody made; the row is exited with none.
                const data = event.data as { procId: string }
                const node = byId.get(data.procId)
                if (!node) break
                node.status = "exited"
                if (typeof event.at === "number") node.endedAt = event.at
                break
            }
            case "process:proc:denied": {
                // Nothing ever started, so there is no span to close. The row
                // exists so a caller awaiting the handle settles rather than
                // hanging, and so a refusal is visible rather than silent.
                const data = event.data as { procId: string; command: string }
                const existing = byId.get(data.procId)
                if (existing) {
                    existing.status = "exited"
                    existing.exitCode = -1
                    break
                }
                byId.set(data.procId, {
                    procId: data.procId,
                    kind: "managed",
                    command: data.command,
                    status: "exited",
                    exitCode: -1,
                    startedAt: typeof event.at === "number" ? event.at : Date.now(),
                    output: [],
                })
                break
            }
        }
    }

    const children = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt)
    if (!opts?.main) return children

    return [
        {
            procId: "main",
            kind: "main",
            command: "agent · ts runtime",
            ...(opts.main.pid !== undefined ? { pid: opts.main.pid } : {}),
            status: opts.main.status,
            startedAt: opts.main.startedAt ?? children[0]?.startedAt ?? Date.now(),
            main: true,
            output: [],
        },
        ...children,
    ]
}

/**
 * Append a live byte-stream chunk to a row's output.
 *
 * Separate from the fold because these events are TRANSIENT — they never reach
 * the log, so they can only arrive from a live bus. A surface watching a local
 * agent calls this from its bus subscription; a surface reading a mirrored
 * remote log simply never does, and gets correct rows with empty output.
 */
export function appendOutput(tree: ProcNode[], procId: string, data: string): void {
    const node = tree.find(entry => entry.procId === procId)
    if (!node) return
    for (const line of data.split(/\r?\n/)) {
        if (!line) continue
        node.output.push(line)
    }
    if (node.output.length > OUTPUT_MAX) node.output.splice(0, node.output.length - OUTPUT_MAX)
}

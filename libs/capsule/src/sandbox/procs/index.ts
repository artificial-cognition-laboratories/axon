import { randomUUID } from "node:crypto"
import type { CapsuleCommand, LiveProcHandle, ProcSpawnOptions } from "../../../types"
import type { CapsuleBusT } from "../../../platform/bus"
import { wrapEntry, type ProcEntry } from "./handle"

const BUFFER_MAX = 1000

type ProcsOpts = {
    send(cmd: CapsuleCommand): void
    bus: CapsuleBusT
}

/**
 * Procs — the host-side mirror of managed child processes.
 *
 * Pure protocol client: commands out via send, state in via events. The
 * mirror's correctness rests on the stdio pipe's FIFO ordering — events
 * arrive exactly as emitted. Entries are mutated in place so held handles
 * stay live.
 *
 * When the capsule subprocess dies, everything below it died too: all
 * running entries are marked exited on capsule:exit.
 */
export function Procs(opts: ProcsOpts) {
    const { send, bus } = opts

    const entries = new Map<string, ProcEntry>()
    // Per-proc line subscribers; key procId + ":exit" fires once on exit.
    const subscribers = new Map<string, Set<(line: string) => void>>()

    function subscribe(key: string, cb: (line: string) => void): () => void {
        let set = subscribers.get(key)
        if (!set) {
            set = new Set()
            subscribers.set(key, set)
        }
        set.add(cb)
        return () => set!.delete(cb)
    }

    function notify(key: string, data: string) {
        const set = subscribers.get(key)
        if (!set?.size) return
        for (const line of data.split(/\r?\n/)) {
            if (!line && key.endsWith(":exit") === false) continue
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

    // ── Mirror maintenance ───────────────────────────────────────────────────

    bus.on("capsule:proc:spawned", e => {
        const existing = entries.get(e.procId)
        if (existing) {
            // Optimistically created by spawn() — fill in what the sandbox reports.
            existing.pid = e.pid
            existing.cwd = e.cwd
            return
        }
        // Blocking runs are observable history, not an unbounded process
        // ledger. Retain only the newest settled rows for inspection.
        if (e.kind === "run") {
            const settled = [...entries.values()]
                .filter(entry => entry.kind === "run" && entry.status === "exited")
                .sort((a, b) => a.startedAt - b.startedAt)
            for (const stale of settled.slice(0, Math.max(0, settled.length - 49))) entries.delete(stale.procId)
        }

        entries.set(e.procId, {
            procId: e.procId,
            kind: e.kind,
            command: e.command,
            pid: e.pid,
            cwd: e.cwd,
            status: "running",
            stdout: [],
            stderr: [],
            startedAt: Date.now(),
        })
    })

    bus.on("capsule:proc:stdout", e => {
        const entry = entries.get(e.procId)
        if (!entry) return
        entry.stdout.push(e.data)
        if (entry.stdout.length > BUFFER_MAX) entry.stdout.shift()
        notify(e.procId, e.data)
    })

    bus.on("capsule:proc:stderr", e => {
        const entry = entries.get(e.procId)
        if (!entry) return
        entry.stderr.push(e.data)
        if (entry.stderr.length > BUFFER_MAX) entry.stderr.shift()
    })

    bus.on("capsule:proc:exit", e => {
        const entry = entries.get(e.procId)
        if (entry) markExited(entry, e.code)
    })

    bus.on("capsule:proc:denied", e => {
        // The spawn never happened — drop the optimistic entry as a failed exit
        // so awaiting handles settle instead of hanging.
        const entry = entries.get(e.procId)
        if (entry) markExited(entry, -1)
    })

    // The capsule subprocess died — every child below it died with it.
    bus.on("capsule:exit", () => {
        for (const entry of entries.values()) {
            if (entry.status === "running") markExited(entry, undefined)
        }
    })

    // ── Surface ──────────────────────────────────────────────────────────────

    function impl(procId: string) {
        return {
            kill: () => send({ type: "proc:kill", procId }),
            stdin: (data: string) => send({ type: "proc:stdin", procId, data }),
            subscribe,
        }
    }

    return {
        /** Spawn a managed child in the capsule. The handle is live immediately. */
        spawn(command: string, spawnOpts?: ProcSpawnOptions): LiveProcHandle {
            const procId = randomUUID()
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
            send({
                type: "proc:spawn",
                procId,
                command,
                ...(spawnOpts?.cwd ? { cwd: spawnOpts.cwd } : {}),
                ...(spawnOpts?.env ? { env: spawnOpts.env } : {}),
            })
            return wrapEntry(entry, impl(procId))
        },

        kill(procId: string): void {
            send({ type: "proc:kill", procId })
        },

        stdin(procId: string, data: string): void {
            send({ type: "proc:stdin", procId, data })
        },

        get(procId: string): LiveProcHandle | undefined {
            const entry = entries.get(procId)
            return entry ? wrapEntry(entry, impl(procId)) : undefined
        },

        list(): LiveProcHandle[] {
            return [...entries.values()].map(entry => wrapEntry(entry, impl(entry.procId)))
        },
    }
}

export type ProcsT = ReturnType<typeof Procs>

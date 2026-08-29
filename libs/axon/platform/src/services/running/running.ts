import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs"
import type { FSWatcher } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AxonInstance } from "@arcforge/types"

/**
 * Every store root a locally-booted agent might register in.
 *
 * `~/.axon` is the installed CLI's store; `~/.axon-dev` is what a source
 * build uses (see resolvePlatformEnvironment — production is hermetic, so
 * source development gets its own store and the two cannot collide). They
 * hold the same shape and describe the same machine, so an observer reads
 * both: an agent is running whether or not the binary that booted it was
 * the installed one.
 */
const ROOTS = [
    join(homedir(), ".axon", "cache", "running"),
    join(homedir(), ".axon-dev", "cache", "running"),
    // The pre-cache/ locations. Read, never written — an agent booted by an
    // older binary is still running on this machine, and an observer that
    // could not see it would report the machine as idle while it worked.
    // Records here drain on their own: every reader probes the pid, so one
    // whose process has gone is already indistinguishable from no record.
    join(homedir(), ".axon", "running"),
    join(homedir(), ".axon-dev", "running"),
]

/** True if a process with this pid exists — sends no signal (kill(pid, 0)), just probes. */
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

/**
 * A record that fails to parse (a write torn mid-flush) or predates the
 * current shape is treated as absent rather than thrown — the next write
 * supersedes it, and one bad file must never empty a reader's whole view.
 */
function read(path: string): AxonInstance | null {
    try {
        const record = JSON.parse(readFileSync(path, "utf-8")) as AxonInstance
        return typeof record.dataRoot === "string" && typeof record.pid === "number" ? record : null
    } catch {
        return null
    }
}

type RunningOpts = {
    /** Where THIS process registers itself. Readers still see every root. */
    root?: string
    /** Coalesce a burst of fs events (several agents booting at once) into one callback. */
    debounceMs?: number
    /** How often to re-check without an fs event — catches a crashed pid, which touches no file. */
    pollMs?: number
}

/**
 * Running — the registry of locally-running Axon processes.
 *
 * One file per live process at `<store>/running/<sessionId>.json`, with the
 * pid as the liveness proof. No daemon, no IPC, no lockfile: any process on
 * the machine can read it, and correctness comes from the OS rather than
 * from cooperation between writers.
 *
 * Self-healing by construction. A dead record is DELETED on read, not
 * skipped, so GC happens on whichever process looks next and a `kill -9`
 * leaves no permanent ghost. That is also why the registry holds no
 * authored state — nothing here can disagree with reality, because
 * everything here is either checkable against the OS or written once at
 * boot.
 *
 * Answers exactly one question: what is running RIGHT NOW. A finished run
 * leaves nothing behind; its session log is the durable trace.
 */
export function Running(opts: RunningOpts = {}) {
    const writeRoot = opts.root ?? ROOTS[0]!
    const debounceMs = opts.debounceMs ?? 100
    const pollMs = opts.pollMs ?? 5000

    let watchers: FSWatcher[] = []
    let poll: ReturnType<typeof setInterval> | null = null
    let debounce: ReturnType<typeof setTimeout> | null = null
    const listeners = new Set<(instances: AxonInstance[]) => void>()

    function fileOf(root: string, sessionId: string): string {
        return join(root, `${sessionId}.json`)
    }

    function snapshot(): AxonInstance[] {
        // Deduped by session id: one process cannot register twice, but a
        // stale record in one root must never shadow the live one in another.
        const live = new Map<string, AxonInstance>()

        for (const root of ROOTS) {
            if (!existsSync(root)) continue

            for (const name of readdirSync(root)) {
                if (!name.endsWith(".json")) continue
                const path = join(root, name)
                const record = read(path)
                if (!record) continue

                if (isAlive(record.pid)) live.set(record.sessionId, record)
                else rmSync(path, { force: true })
            }
        }

        return [...live.values()]
    }

    function notify(): void {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
            debounce = null
            const instances = snapshot()
            for (const listener of listeners) listener(instances)
        }, debounceMs)
    }

    return {
        /** Every root read by list()/watch(). Exposed for diagnostics, not for callers to walk. */
        roots: ROOTS,

        /** Register this process. Called once, immediately after the runtime is up. */
        start(instance: AxonInstance): void {
            // 0700/0600: a record may carry the instance's control-channel
            // token, which is the only thing standing between another local
            // account and a socket that drives this agent. The mode is set
            // on the directory AND the file because `recursive: true` does
            // not re-chmod a directory that already exists from an earlier
            // version.
            mkdirSync(writeRoot, { recursive: true, mode: 0o700 })
            chmodSync(writeRoot, 0o700)
            writeFileSync(fileOf(writeRoot, instance.sessionId), JSON.stringify(instance, null, 2), { mode: 0o600 })
        },

        /** Deregister. Called first thing on shutdown — a reader must never see "alive" for a session mid-teardown. */
        stop(sessionId: string): void {
            for (const root of ROOTS) rmSync(fileOf(root, sessionId), { force: true })
        },

        /** Every currently-live instance, pid-checked fresh. Dead records are GC'd as a side effect. */
        list(): AxonInstance[] {
            return snapshot()
        },

        /** One instance by session id, or null when it is not running. */
        get(sessionId: string): AxonInstance | null {
            return snapshot().find(instance => instance.sessionId === sessionId) ?? null
        },

        /**
         * Subscribe to the live list. Called once immediately with the
         * current snapshot, then on every add/remove/crash.
         *
         * Two triggers, because one is not enough: fs.watch fires instantly
         * when a record appears or is deleted, and a slow poll catches a
         * killed process — which touches no file and so fires no fs event
         * at all. Returns an unsubscribe function.
         */
        watch(listener: (instances: AxonInstance[]) => void): () => void {
            if (!watchers.length) {
                for (const root of ROOTS) {
                    mkdirSync(root, { recursive: true }) // fs.watch throws on a missing directory
                    watchers.push(watch(root, () => notify()))
                }
                poll = setInterval(() => notify(), pollMs)
            }

            listeners.add(listener)
            listener(snapshot())

            return () => {
                listeners.delete(listener)
                if (listeners.size === 0) stopWatching()
            }
        },

        dispose(): void {
            stopWatching()
            listeners.clear()
        },
    }

    function stopWatching(): void {
        for (const fsWatcher of watchers) fsWatcher.close()
        watchers = []
        if (poll) clearInterval(poll)
        poll = null
        if (debounce) clearTimeout(debounce)
        debounce = null
    }
}

export type RunningT = ReturnType<typeof Running>

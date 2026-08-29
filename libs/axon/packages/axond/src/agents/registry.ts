import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AxonInstance } from "@arcforge/types"

type RegistryOpts = {
    /**
     * Where THIS process writes.
     *
     * Readers still span every store root as well — an agent is running
     * whether or not the binary that booted it was the installed one, and that
     * is the whole reason both are read.
     */
    root?: string
    /**
     * Read ONLY `root`, ignoring the machine's real store roots.
     *
     * For tests, and named as such rather than implied by passing `root`.
     * Scoping reads to one directory is not what a caller wants in production
     * — it would hide agents booted by the other binary — so it has to be
     * asked for explicitly.
     *
     * Without it a suite is not isolated: it reads the developer's own
     * `~/.axon`, and every assertion about an empty machine passes only while
     * nothing happens to be running.
     */
    isolated?: boolean
    /** Coalesce a burst of fs events — several agents booting at once — into one notification. */
    debounceMs?: number
    /**
     * How often to re-check without an fs event.
     *
     * Load-bearing: a KILLED process touches no file, so nothing fires. Without
     * a poll a crashed agent stays "running" in every reader's view until
     * something unrelated happens to write to the directory.
     */
    pollMs?: number
}

/**
 * Every store root a locally-booted agent might register in.
 *
 * `~/.axon` is the installed CLI's store; `~/.axon-dev` is what a source build
 * uses. They describe the SAME machine, so an observer reads both — an agent
 * is running whether or not the binary that booted it was the installed one.
 *
 * The pre-`cache/` locations are read and never written: an agent booted by an
 * older binary is still running, and an observer that could not see it would
 * report the machine as idle while it worked. Those records drain on their
 * own, because every reader probes the pid.
 */
const ROOTS = [
    join(homedir(), ".axon", "cache", "running"),
    join(homedir(), ".axon-dev", "cache", "running"),
    join(homedir(), ".axon", "running"),
    join(homedir(), ".axon-dev", "running"),
] as const

/**
 * Registry — what is running on this machine, from the files agents publish.
 *
 * ── Why files, when a daemon exists ─────────────────────────────────────────
 *
 * Because the daemon must not be required for an agent to run. A file every
 * reader can pid-check works with no daemon at all, which is what makes the
 * daemon's absence a degraded mode rather than an outage. The daemon becomes
 * the AUTHORITATIVE reader — and, once it supervises, the only writer — but
 * the protocol underneath stays honest on its own.
 *
 * ── The pid is the liveness proof ───────────────────────────────────────────
 *
 * Not a heartbeat, not a timestamp. `kill(pid, 0)` is the whole check, and a
 * record whose process is gone is deleted where it is found — every reader
 * already has to probe to answer honestly, so cleaning up while it looks costs
 * nothing and means no reaper exists to fail.
 */
export function Registry(opts: RegistryOpts = {}) {
    const writeRoot = opts.root ?? ROOTS[1]
    /** Every directory this instance reads. See `isolated`. */
    const readRoots = opts.isolated === true ? [writeRoot] : [...new Set([...ROOTS, writeRoot])]
    const debounceMs = opts.debounceMs ?? 50
    const pollMs = opts.pollMs ?? 2_000

    const listeners = new Set<(instances: AxonInstance[]) => void>()
    let watchers: FSWatcher[] = []
    let poll: ReturnType<typeof setInterval> | null = null
    let debounce: ReturnType<typeof setTimeout> | null = null

    /** Every live record, reaping dead ones as it reads. */
    function snapshot(): AxonInstance[] {
        const found: AxonInstance[] = []
        const seen = new Set<string>()

        for (const root of readRoots) {
            if (!existsSync(root)) continue

            for (const name of readdirSync(root)) {
                if (!name.endsWith(".json")) continue
                const path = join(root, name)
                const record = read(path)

                if (!record || !alive(record.pid)) {
                    // Best-effort: two readers reaping the same record at once
                    // is the ordinary case, not a fault.
                    try { rmSync(path, { force: true }) } catch { /* raced */ }
                    continue
                }

                // The same agent visible through two roots is one agent — a
                // record written pre-migration and re-written since.
                if (seen.has(record.sessionId)) continue
                seen.add(record.sessionId)
                found.push(record)
            }
        }

        return found.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    }

    function notify(): void {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
            const instances = snapshot()
            for (const listener of listeners) listener(instances)
        }, debounceMs)
    }

    function stopWatching(): void {
        for (const fsWatcher of watchers) fsWatcher.close()
        watchers = []
        if (poll) clearInterval(poll)
        poll = null
        if (debounce) clearTimeout(debounce)
        debounce = null
    }

    return {
        /** Every root scanned. Diagnostics — "why is my agent missing" is otherwise unanswerable. */
        roots: readRoots as readonly string[],

        /** Every live instance, newest first. Dead records are collected as a side effect. */
        list: snapshot,

        /** One instance by session id, or null when it is not running. */
        get(sessionId: string): AxonInstance | null {
            return snapshot().find(instance => instance.sessionId === sessionId) ?? null
        },

        /**
         * Register a running agent.
         *
         * `0o700`/`0o600`, because a record may carry the control-channel
         * token — the only thing between another local account and a socket
         * that drives this agent. The mode is set on the directory AND the
         * file: `recursive: true` does not re-chmod one that already exists.
         */
        start(instance: AxonInstance): void {
            mkdirSync(writeRoot, { recursive: true, mode: 0o700 })
            writeFileSync(join(writeRoot, `${instance.sessionId}.json`), JSON.stringify(instance, null, 2), { mode: 0o600 })
        },

        /**
         * Deregister. Called FIRST on shutdown, before the process goes.
         *
         * A reader must never see "alive" for a session mid-teardown — the pid
         * is still real for as long as the process is draining, so the record
         * is what has to go first.
         */
        stop(sessionId: string): void {
            for (const root of readRoots) {
                try { rmSync(join(root, `${sessionId}.json`), { force: true }) } catch { /* raced */ }
            }
        },

        /**
         * Subscribe to the live list. Called once immediately, then on change.
         *
         * TWO triggers, because neither covers the other: `fs.watch` fires the
         * instant a record appears or is deleted, and a slow poll catches a
         * KILLED process — which touches no file and so fires no event at all.
         */
        watch(listener: (instances: AxonInstance[]) => void): () => void {
            if (watchers.length === 0) {
                for (const root of readRoots) {
                    // fs.watch throws on a missing directory, and a store that
                    // has never run an agent has none.
                    mkdirSync(root, { recursive: true })
                    watchers.push(watch(root, () => notify()))
                }
                poll = setInterval(() => notify(), pollMs)
                poll.unref?.()
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
}

export type RegistryT = ReturnType<typeof Registry>

/**
 * A record that fails to parse is treated as absent.
 *
 * A write torn mid-flush must not empty a reader's whole view, and the next
 * write supersedes it. Permissive here risks showing one stale agent;
 * strict would break every reader on one bad file.
 */
function read(path: string): AxonInstance | null {
    try {
        const record = JSON.parse(readFileSync(path, "utf-8")) as AxonInstance
        return typeof record.dataRoot === "string" && typeof record.pid === "number" ? record : null
    } catch {
        return null
    }
}

/** True if a process with this pid exists — probes, sends nothing. */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

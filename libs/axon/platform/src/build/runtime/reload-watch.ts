import type { WatcherT } from "../project/watcher"

/**
 * Hot reload on file change, for one running agent.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * It did not. `AgentOpts.watch` was declared, documented as "Default true",
 * and read by nothing; `Project()` built a watcher whose own comment said
 * "inert until start() is called (Agent does, for dev)" and `Agent()` never
 * called it. The only started watcher in the tree was the profile's, which
 * explicitly ignores `agents/` — and an agent reached through
 * `settings.paths` is not under the profile root at all.
 *
 * So no agent file was watched. Edits appeared to hot-reload only because a
 * profile-level change fired `reloadAll()`, which rescans every instance; a
 * `.env` save on its own did nothing, which is how this surfaced.
 *
 * ── The failure mode this is shaped around ──────────────────────────────────
 *
 * A reload loop. An agent with a microphone once reloaded ~1700 times in two
 * minutes — the sensory ring wrote a frame every 32ms, each write triggered a
 * reload, and the agent never finished booting before the next one began.
 * Runtime output now lives under `.agent/`, which the watcher's DEFAULT_IGNORE
 * prunes wholesale, so that specific loop is impossible by construction. The
 * guards below are for the general shape:
 *
 *   debounce      an editor writes several times per save (temp, rename, touch)
 *   suppression   a reload's OWN writes must not schedule the next reload
 *   re-entrancy   a change arriving mid-reload must not start a second one
 *   deaf window   writes still landing after a reload returns are its own
 *
 * Modelled on the profile watcher (build/extensions/extensions.ts), which
 * solved this first and has been carrying it in production since. Same four
 * guards, same numbers, deliberately — two different answers to one problem
 * is how the second one drifts.
 *
 * ── Why the agent owns this, and not the daemon ─────────────────────────────
 *
 * The daemon has broader privileges, which is exactly the argument against.
 * WHICH files matter is a project fact — the root, the ignore list, the cognet
 * source path — and the daemon knows an agent by its record (pid, socket,
 * session), not by its layout. Teaching it a project's shape would make
 * "watch the cognet source too" a daemon change.
 *
 * And a loop scoped to one agent costs that agent. A loop inside a
 * machine-wide daemon is one bad write away from being every agent's problem.
 * Privilege is not the constraint either: the agent process already reads its
 * own `.env` at boot, so watching a file it already reads grants nothing.
 */

/**
 * How long after a reload returns its own writes may still be arriving.
 *
 * Comfortably over the debounce, since a notification scheduled just before
 * the gate closes lands one window later.
 */
const TAIL_MS = 400

export type ReloadWatchOpts = {
    watcher: WatcherT
    /** The reload to run. Its failures are already on the agent's session log. */
    reload: () => Promise<void>
}

/**
 * Start watching. Returns the stop function.
 *
 * Never throws and never rejects into the caller: a watcher is an accelerant,
 * and an agent whose boot failed because a file could not be watched would be
 * strictly worse than one that simply needs `:reload`.
 */
export function ReloadWatch(opts: ReloadWatchOpts): () => void {
    let running = false
    let deafUntil = 0

    const stop = opts.watcher.onChange(() => {
        // Re-entrancy and the deaf window, in that order. A change arriving
        // while a reload runs is that reload's business — either it is our own
        // write, or the next save will notify again.
        if (running || Date.now() < deafUntil) return
        running = true

        void (async () => {
            try {
                await opts.reload()
            } catch {
                // Already durable: Agent's reload() commits
                // axon:reload:start/failed to the session log, and the
                // timeline renders it. Rethrowing here would surface as an
                // unhandled rejection in the supervisor with no added fact.
            } finally {
                running = false
                deafUntil = Date.now() + TAIL_MS
            }
        })()
    })

    // Fire-and-forget: start() walks the tree, and a slow walk must not hold
    // up the agent that is already running.
    void opts.watcher.start()

    return () => {
        stop()
        opts.watcher.stop()
    }
}

export { TAIL_MS as RELOAD_TAIL_MS }

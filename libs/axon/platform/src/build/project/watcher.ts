import { watch } from "node:fs"
import type { FSWatcher } from "node:fs"

export type DuringOptions = {
    /**
     * The caller reloads on its own once `during()` returns, so changes made
     * inside it must not also be delivered as a notification.
     *
     * ── The tradeoff this accepts ───────────────────────────────────────────
     *
     * A suspension holds ONE pending path, and it cannot tell the caller's own
     * writes apart from a user's edit that happened to land in the same
     * window. So this discards both: a file the user saved during a `bun
     * install` is not picked up until they touch something again.
     *
     * That is the right trade for the callers that set it. An install is
     * seconds long and rewrites the project underneath the user; an edit
     * landing inside that window is rare, and the alternative — a guaranteed
     * duplicate full rescan on every single install — is constant. Callers
     * that do NOT reload themselves must leave this unset, where a held
     * change is always delivered.
     */
    selfReloads?: boolean
}

export type WatcherOpts = {
    root: string
    /** Directory names pruned from the watch entirely (e.g. node_modules, .git). */
    ignore?: string[]
    /** Path prefixes (relative to root) pruned from the watch entirely (e.g. data/sessions). */
    ignorePaths?: string[]
    /**
     * Prunes by BASENAME, at any depth — for transient files whose name is the
     * only thing identifying them, wherever they appear. A prefix list cannot
     * express that: the config loader's reload copies sit beside whichever file
     * they shadow, so their directory is not known in advance.
     */
    ignoreFiles?: (name: string) => boolean
    /** Coalesce a burst of fs events (editor saves touch multiple files) into one callback. */
    debounceMs?: number
}

const DEFAULT_IGNORE = ["node_modules", ".git", ".agent", ".module", "dist"]

// The agent's own runtime output, at its PRE-MIGRATION location. Every
// commit appends to a JSONL file under these paths, so without excluding
// them a live request self-triggers a reload mid-run: the write lands
// mid-request, the debounced reload fires, and the in-flight run gets killed
// out from under itself.
//
// data/sensory is the sensory ring, and it is far worse than sessions ever
// was: a 31Hz microphone writes every 32ms, which is a reload every 32ms
// forever. An agent with a mic reloaded ~1700 times in a couple of minutes
// — fast enough that it never finished booting before the next one started.
//
// Runtime output now lands in `.agent/data`, which DEFAULT_IGNORE already
// prunes wholesale — the frame is generated output and none of it should
// ever trigger a reload. That is the real fix for this class of bug: a
// reload loop is now impossible by construction rather than by remembering
// to list each new retention tier here.
//
// These entries remain for agents that have not been re-prepared yet, whose
// output is still at the old path. They cost two string comparisons and are
// safe to delete once no such agent can plausibly exist. Note only the
// runtime-output paths are named, never all of data/ — knowledge files are
// real project content a user still wants reloads for.
const DEFAULT_IGNORE_PATHS = ["data/sessions", "data/sensory"]

/**
 * Watcher — raw filesystem change notifications for one project root.
 * Knows nothing about blueprints, Axon, or what a "reload" means — that
 * interpretation belongs to whoever consumes the events (Agent, in dev).
 */
export function Watcher(opts: WatcherOpts) {
    const ignore = new Set(opts.ignore ?? DEFAULT_IGNORE)
    const ignorePaths = opts.ignorePaths ?? DEFAULT_IGNORE_PATHS
    const ignoreFiles = opts.ignoreFiles
    const debounceMs = opts.debounceMs ?? 100

    let fsWatcher: FSWatcher | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const listeners = new Set<(path: string) => void>()

    /**
     * Nesting depth of suspend() calls, and the one change seen while
     * suspended (if any).
     *
     * A counter rather than a boolean so overlapping suspensions can't have
     * the inner one resume the outer's window. `pending` holds a path rather
     * than a flag because resume() must still deliver a notification: a user
     * editing a file DURING an install is a real change, and dropping it
     * would leave the agent stale until they touched something else.
     */
    let suspended = 0
    let pending: string | null = null
    /** The path a currently-armed debounce timer will deliver, if any. */
    let scheduled: string | null = null

    /**
     * Schedule the debounced notification. The single place the timer is set,
     * so a resume and a normal fs event share one window rather than racing
     * each other into two callbacks.
     */
    function notify(path: string): void {
        if (timer) clearTimeout(timer)
        scheduled = path
        timer = setTimeout(() => {
            timer = null
            scheduled = null
            for (const listener of listeners) listener(path)
        }, debounceMs)
    }

    /**
     * Whether this watcher would drop a change to `filename`.
     *
     * Public because it is the one part of the watch decision that cannot be
     * exercised through start()/onChange(): a Windows-separator path never
     * arrives from fs.watch() on the host running the tests, and the whole
     * point of normalizing is that it behaves identically when it does.
     */
    function ignores(filename: string): boolean {
        const path = normalizePath(filename)
        if (path.split("/").some(segment => ignore.has(segment))) return true
        if (ignoreFiles?.(path.split("/").at(-1) ?? "")) return true
        return ignorePaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
    }

    return {
        ignores: ignores,

        /**
         * Start watching. Idempotent — a second call is a no-op while
         * already running.
         *
         * Recursive inotify watches (Linux) aren't fully attached the
         * instant fs.watch() returns — a change landing immediately after
         * can be silently dropped while the kernel finishes registering
         * watches on the existing subtree. Awaiting start() guarantees the
         * watch is actually live before the caller proceeds.
         */
        async start(): Promise<void> {
            if (fsWatcher) return
            fsWatcher = watch(opts.root, { recursive: true }, (_event, filename) => {
                if (!filename) return
                if (ignores(filename)) return
                const path = normalizePath(filename)

                // Held, not dropped — resume() delivers it. The debounce timer
                // is deliberately not started: a suspension can outlast it by
                // far (a `bun install` is seconds), and firing mid-way is the
                // whole thing suspension exists to prevent.
                if (suspended > 0) {
                    pending = path
                    return
                }

                notify(path)
            })
            await Bun.sleep(75)
        },

        /** Stop watching. Idempotent. */
        stop(): void {
            fsWatcher?.close()
            fsWatcher = null
            if (timer) clearTimeout(timer)
            timer = null
        },

        /** Subscribe to (debounced) change notifications. Returns an unsubscribe function. */
        onChange(listener: (path: string) => void): () => void {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },

        /**
         * Run `fn` without notifying listeners of changes IT causes.
         *
         * For a caller that is deliberately rewriting the project and will
         * account for the result itself — an install writes package.json,
         * bunfig.toml and axon.config.ts, then rebuilds node_modules. Left to
         * the watcher, the manifest writes fire a reload ~100ms later, which
         * rescans while `bun install` still has the tree torn down, and the
         * cognet build correctly reports a runtime that is genuinely absent
         * for that instant. The install then succeeds — leaving two error
         * cards for an operation that worked.
         *
         * Suspension is not silencing: a change that arrives during `fn` is
         * held and delivered on resume, so a user edit mid-install is not
         * lost. What it removes is the watcher inferring a reload from writes
         * whose author already knows what they mean.
         *
         * Restores on throw — an install that fails must not leave the
         * watcher deaf for the rest of the session.
         */
        async during<T>(fn: () => Promise<T>, options: DuringOptions = {}): Promise<T> {
            // A debounce window already open when suspension starts would fire
            // INSIDE fn() — exactly the mid-install reload this prevents. Fold
            // it into the suspension instead of letting it land: the change is
            // still real, so it is held and delivered on resume like any other.
            if (suspended === 0 && timer) {
                clearTimeout(timer)
                timer = null
                pending = scheduled
                scheduled = null
            }
            suspended++
            try {
                return await fn()
            } finally {
                suspended--

                // The caller reloads for itself, so the writes it just made
                // must not ALSO arrive as a change notification.
                //
                // fs.watch cannot say who wrote a file, so attribution is
                // impossible to infer here — it has to be declared by the one
                // party that knows: the caller that both made the writes and
                // will act on them. An install rewrote package.json,
                // bunfig.toml, axon.config.ts and all of node_modules, then
                // reloads once itself; delivering the held change on top of
                // that ran the entire scan a second time for the same event.
                //
                // The cost of this being wrong is asymmetric, which is why it
                // is opt-in rather than the default: a missed notification
                // leaves the agent silently stale until the user touches
                // something else, while a spurious one is only wasted work.
                // Callers that do not reload themselves keep the safe
                // behaviour without having to know this option exists.
                //
                // Only the OUTERMOST suspension may discard, and only if it
                // is the one that asked to. An inner `during(..., selfReloads)`
                // nested inside a plain outer one would otherwise throw away a
                // change the outer caller is still relying on being told
                // about — the inner reload covers its own writes, not
                // everything the outer span went on to do afterwards.
                if (suspended === 0 && options.selfReloads) pending = null

                if (suspended === 0 && pending !== null) {
                    const path = pending
                    pending = null
                    // Scheduled through the same debounce every other event
                    // uses, deliberately: fs notifications are asynchronous, so
                    // the tail of a burst written inside fn() keeps arriving
                    // for a few ms AFTER resume. Those land on the normal path
                    // and restart this timer, folding themselves into this one
                    // notification instead of producing a second — which is
                    // what an install's three manifest writes did.
                    notify(path)
                }
            }
        },
    }
}

export type WatcherT = ReturnType<typeof Watcher>

/**
 * `fs.watch()` reports project-relative paths using the host separator. Keep
 * watcher contracts POSIX-shaped so ignore prefixes behave identically on
 * Windows (`data\\sessions\\…`) and Unix (`data/sessions/…`).
 */
function normalizePath(filename: string): string {
    return filename.replaceAll("\\", "/")
}

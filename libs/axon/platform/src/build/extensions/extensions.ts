import { mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { err } from "@arcforge/err"
import { gt, valid } from "semver"
import { fsx } from "../../utils/fs"
import { Watcher } from "../project"
import { ProfileConfigFile, resolveEntry, type ResolvedEntry } from "./config"
import { addEntry, addProvider, readEntries, readProviders, readSettings, removeEntry, removeProvider, setSetting } from "./edit"
import { ExtensionStore, formatRef, parseRef, type ExtensionStoreT } from "./store"
import { DisposerSink, disposeSource, loadSource, RELOAD_PREFIX, type LoadedSource } from "./load"

/**
 * Extensions — loads a profile's own config and every extension it enables.
 *
 * Headless. It imports the user's files and tracks what they registered; it
 * knows nothing about a terminal, which is what lets the whole load order,
 * containment and teardown story be tested without one. The API those files
 * call into is installed by the caller before this runs (see `install`).
 *
 * ── Load order is the contract ──────────────────────────────────────────────
 *
 *   profile main.ts → profile plugins/*
 *     → extension[0] main.ts → extension[0] plugins/*
 *     → extension[1] ...
 *
 * The profile goes FIRST so a user's own config wins every collision — under
 * first-wins, order is the policy. Extensions follow in the order
 * profile.config.ts lists them, which is why resolution may be concurrent but
 * loading never is: a load order that varied would make collisions
 * non-deterministic, and "which of my two extensions bound ctrl+o" is not a
 * question anyone should have to answer twice.
 *
 * ── Nothing here throws ─────────────────────────────────────────────────────
 *
 * Every failure lands in the returned result. A user with a broken config still
 * gets a terminal — the one they need in order to go fix it — and the caller
 * decides how loudly to say what broke. That is also the correct layering: this
 * package has no surface to report on.
 */

export type ExtensionsResult = {
    /** Every source that loaded, in load order. The profile is first when present. */
    sources: LoadedSource[]
    /**
     * Failures that are not attributable to one file — an unreadable
     * profile.config.ts, an extension that could not be found or installed.
     * Per-file errors live on their own source's `files`.
     */
    errors: unknown[]
}

export type UninstallResult = {
    /** True when a `profile.config.ts` entry was removed. False when it was not declared. */
    changed: boolean
    /**
     * True when fetched files were deleted from disk.
     *
     * False for a local entry — that is source the user wrote, and uninstall
     * only ever stops loading it. Reported rather than assumed so the CLI can
     * say which of the two happened instead of printing a fixed sentence that
     * is wrong half the time.
     */
    removed: boolean
}

type ExtensionsOpts = {
    /**
     * The active profile's directory, resolved per call.
     *
     * A thunk rather than a value: which profile is active is a function of who
     * is logged in, which changes within one process (`switchProfile`), and
     * reading it at construction would bind this to whoever happened to be
     * active at boot. It may also throw when nobody is — construction is
     * wiring, so that failure belongs at load(), not here.
     */
    root: () => string
    /**
     * Fetches and prepares a registry extension into `dir`.
     *
     * A thunk rather than the Registry handle, same idiom as Zeno's `clone`:
     * registry is constructed in terms of projects, and taking a value here
     * would force a reorder in platform.ts.
     *
     * Omitted by callers that only load local extensions — a registry entry
     * then reports EXTENSION_NOT_FOUND rather than silently doing nothing.
     */
    install?: (ref: string, dir: string) => Promise<{ version: string }>
    /**
     * The newest published version of `name`, without fetching anything.
     *
     * Separate from `install` because checking and applying are different acts
     * with different risk: an extension is arbitrary code that runs at boot, so
     * asking what exists must never be the same call as installing it. Omitted
     * by callers with no registry — `updates()` then reports nothing rather
     * than pretending everything is current.
     */
    latest?: (name: string) => Promise<string>
    /**
     * Where fetched extensions live, shared by every profile. Injected so
     * tests can point it at a scratch dir.
     */
    store?: ExtensionStoreT
}

/** One declared extension, against what the registry currently publishes. */
export type ExtensionUpdate = {
    /** The config entry verbatim, e.g. "@cody/ember-theme@0.2.0". */
    source: string
    name: string
    /** Null for a legacy unpinned entry — it has no version to compare. */
    current: string | null
    /** Null when the registry could not be reached or has no such artifact. */
    latest: string | null
    /** True only when both versions are known AND differ. */
    outdated: boolean
}

/** True when a directory is an extension — it carries the marker config. */
function isExtension(root: string): boolean {
    return fsx.exists(join(root, "extension.config.ts"))
}

export function Extensions(opts: ExtensionsOpts) {
    const store = opts.store ?? ExtensionStore()
    const sink = DisposerSink()
    let loaded: LoadedSource[] = []
    /**
     * What `profile.config.ts` currently declares, whether or not it loaded.
     *
     * Distinct from `sources`, which holds only what actually loaded. A UI
     * offering "uninstall" must list the BROKEN one too — an extension that
     * fails to load is the one a user most needs to remove, and deriving the
     * list from load results makes it the one entry they cannot select.
     *
     * ── Refreshed on every WRITE, not only on load ──────────────────────────
     *
     * This mirrors a file, so it goes stale the instant anything edits that
     * file without loading. install/update/uninstall all do exactly that —
     * they rewrite the config and let the watcher reload asynchronously — so a
     * load-time-only snapshot was wrong for the whole window in between, which
     * is precisely when a user is looking at the list.
     *
     * The symptom was a palette that could not undo itself: after an update,
     * `:ext uninstall` rendered "(none installed)" while the config plainly
     * declared one, because the cache still held the pre-update ref (or, on a
     * fresh handle, nothing at all). Anything that writes the config must call
     * `syncDeclared()`.
     */
    let declared: string[] = []

    /** Re-read the declared list from disk. Call after ANY config write. */
    async function syncDeclared(): Promise<void> {
        declared = await readEntries(opts.root())
    }

    /**
     * addEntry/removeEntry, with the cache refreshed.
     *
     * Wrapped rather than each call site remembering, because forgetting is
     * silent: the write lands, the file is right, and only a UI reading the
     * cache is wrong — which is a bug that surfaces far from its cause. Four
     * call sites and a fifth arriving with the next verb is exactly the shape
     * that wants one door.
     */
    async function declareEntry(root: string, source: string) {
        const result = await addEntry(root, source)
        await syncDeclared()
        return result
    }

    async function undeclareEntry(root: string, source: string) {
        const result = await removeEntry(root, source)
        await syncDeclared()
        return result
    }
    /**
     * Runs a write without the watcher reacting to it. Null when not watching.
     *
     * Held rather than passed per call because only `watch()` knows the
     * watcher exists, and every settings write wants the same treatment.
     */
    let suppress: (<T>(fn: () => Promise<T>) => Promise<T>) | null = null

    /**
     * Materialize one entry, returning the reason it is unusable.
     *
     * A local entry must already exist — it is a path the user wrote, and
     * creating something there would be inventing an extension they did not
     * write. A registry entry is fetched when it is not already usable, then
     * checked the same way, because a fetch that succeeds but produces
     * something without a config is not an extension either.
     */
    async function materialize(entry: ResolvedEntry): Promise<unknown | null> {
        // Fetched only when it is not already a usable extension on disk.
        //
        // Not "when the directory is absent": a half-materialized directory —
        // an interrupted clone, or a fetch that produced something without a
        // config — would otherwise be permanently stuck, since clone() refuses
        // to write into a non-empty target. Clearing it first is what makes a
        // reinstall a repair rather than a no-op.
        if (entry.kind === "registry" && !isExtension(entry.root)) {
            if (fsx.exists(entry.root)) await rm(entry.root, { recursive: true, force: true })

            if (!opts.install) {
                return err("EXTENSION_NOT_FOUND", {
                    detail: `${entry.source} is not installed`,
                    context: { source: entry.source, root: entry.root },
                })
            }
            try {
                await opts.install(entry.source, entry.root)
            } catch (cause) {
                return err("EXTENSION_INSTALL_FAILED", {
                    detail: `${entry.source} — ${cause instanceof Error ? cause.message : String(cause)}`,
                    context: { source: entry.source, root: entry.root },
                    cause,
                })
            }
        }

        if (!fsx.exists(entry.root)) {
            return err("EXTENSION_NOT_FOUND", {
                detail: `${entry.source} → ${entry.root}`,
                context: { source: entry.source, root: entry.root },
            })
        }
        if (!isExtension(entry.root)) {
            return err("EXTENSION_NOT_AN_EXTENSION", {
                detail: `${entry.root} has no extension.config.ts`,
                context: { source: entry.source, root: entry.root },
            })
        }
        return null
    }

    return {
        /** Every source currently loaded, in load order. */
        get sources(): readonly LoadedSource[] {
            return loaded
        },

        /**
         * Every extension the last load DECLARED, in load order — including
         * any that failed. Synchronous, for a UI that cannot await.
         */
        get declared(): readonly string[] {
            return declared
        },

        /**
         * Populate `declared` from disk without loading anything.
         *
         * For a surface that may render the list BEFORE the first load — or
         * before one has been triggered at all. Reading the config is cheap and
         * runs no extension code, which is the whole reason it is safe to offer
         * separately from `load()`.
         */
        syncDeclared,

        /** Every extension the profile declares, in load order. */
        list(): Promise<string[]> {
            return readEntries(opts.root())
        },

        /**
         * The platform settings the config declares.
         *
         * `profile.config.ts` is the source of truth — there is no sidecar
         * store holding runtime overrides, so what a user reads in that file is
         * always what is in effect. A second store would make "why isn't my
         * config taking effect" a real question with a precedence rule for an
         * answer, which is exactly the confusion one file avoids.
         */
        settings(): Promise<Record<string, unknown>> {
            return readSettings(opts.root())
        },

        /**
         * Write one setting, and suppress the reload it would otherwise cause.
         *
         * The watcher sees `profile.config.ts` change and re-runs the whole
         * config — right for a hand edit, wasteful for `:theme set`, which
         * would dispose and re-import every extension to change one string. The
         * caller already applied the change in memory; re-running the config
         * would only arrive at the same state, slower and with a visible hitch.
         *
         * `suppress` is the watcher's own `during()`, handed in by whoever
         * started watching — so this needs no knowledge of whether anything is
         * watching at all.
         */
        async setSetting(key: string, value: unknown): Promise<{ changed: boolean }> {
            const root = opts.root()
            const write = () => setSetting(root, key, value)
            return suppress ? suppress(write) : write()
        },

        /**
         * The provider factories this profile declares.
         *
         * Read from the config rather than from a cache, because the user may
         * have edited it by hand — `providers:` is theirs to write, and the
         * connect commands are a convenience over it, not the only way in.
         */
        readProviders(): Promise<string[]> {
            return readProviders(opts.root())
        },

        /**
         * Declare a provider — called after its vault connection succeeds.
         *
         * Suppressed like every other config write: rewriting the file must
         * not fire the watcher's reload, or connecting a provider would
         * restart every extension as a side effect.
         */
        async addProvider(factory: string): Promise<{ changed: boolean }> {
            const root = opts.root()
            const write = () => addProvider(root, factory)
            return suppress ? suppress(write) : write()
        },

        /** Undeclare a provider — called after its vault connection is dropped. */
        async removeProvider(factory: string): Promise<{ changed: boolean }> {
            const root = opts.root()
            const write = () => removeProvider(root, factory)
            return suppress ? suppress(write) : write()
        },

        /**
         * Does this local path point at an extension?
         *
         * The marker config is the only test — the same one the loader applies
         * — so "is it an extension" has exactly one answer everywhere rather
         * than a CLI-side guess that can disagree with what load() will do.
         *
         * False for a path that does not exist. A caller routing on this wants
         * to know whether to treat it as an extension, and a missing directory
         * is not one; the install it falls through to reports the absence with
         * the context to fix it.
         */
        isLocalExtension(source: string): boolean {
            try {
                return isExtension(resolveEntry(source, opts.root(), store).root)
            } catch {
                // resolveEntry needs an active profile, and nobody may be
                // logged in. Not an extension we can install, which is the
                // same answer either way.
                return false
            }
        },

        /**
         * Fetch an extension and record it in `profile.config.ts`.
         *
         * Two steps, in this order: materialize first, declare second. A config
         * naming an extension that is not on disk reports EXTENSION_NOT_FOUND
         * on every boot until someone edits the file — so nothing is written
         * until there is something for it to point at.
         *
         * Idempotent. Re-installing an already-declared extension refetches it
         * (a repair) and leaves the config alone.
         */
        async install(source: string): Promise<{ root: string; declared: boolean; ref: string }> {
            const root = opts.root()

            // A local path is declared as written and lives where it sits —
            // it is the user's own source, and copying it into a shared store
            // would make the copy the thing that loads.
            if (resolveEntry(source, root, store).kind === "local") {
                const entry = resolveEntry(source, root, store)
                const problem = await materialize(entry)
                if (problem) throw problem
                const { changed } = await declareEntry(root, source)
                return { root: entry.root, declared: changed, ref: source }
            }

            const { name, version: pinned } = parseRef(source)

            // Already stored at the pinned version — nothing to fetch. This is
            // what makes a second profile's install instant, and it is the
            // whole point of the shared store.
            const existing = pinned ? store.resolve(source) : null
            if (existing) {
                const ref = formatRef(existing.name, existing.version)
                const { changed } = await declareEntry(root, ref)
                return { root: existing.root, declared: changed, ref }
            }

            if (!opts.install) {
                throw err("EXTENSION_NOT_FOUND", {
                    detail: `${source} is not installed`,
                    context: { source },
                })
            }

            // Fetched into a staging path, then moved to its version once the
            // registry says what that version is: the destination is not
            // knowable until resolution, and a directory named for a version
            // it does not hold is worse than one that briefly does not exist.
            const staging = join(store.root, ".staging", crypto.randomUUID())
            let resolvedVersion: string
            try {
                ;({ version: resolvedVersion } = await opts.install(source, staging))
            } catch (cause) {
                await rm(staging, { recursive: true, force: true })
                throw err("EXTENSION_INSTALL_FAILED", {
                    detail: `${source} — ${cause instanceof Error ? cause.message : String(cause)}`,
                    context: { source },
                    cause,
                })
            }

            const target = store.pathFor(name, resolvedVersion)
            if (store.isUsable(target)) {
                // Another profile fetched this version while we were fetching.
                // Theirs is as good as ours — drop the duplicate.
                await rm(staging, { recursive: true, force: true })
            } else {
                await mkdir(dirname(target), { recursive: true })
                await rename(staging, target)
            }

            const ref = formatRef(name, resolvedVersion)
            const { changed } = await declareEntry(root, ref)
            return { root: target, declared: changed, ref }
        },

        /**
         * Uninstall an extension: undeclare it. Files are left alone.
         *
         * ── Nothing is deleted, and that is the point ───────────────────────
         *
         * Fetched extensions live in a MACHINE-WIDE store now, shared by every
         * profile. Deleting the directory would rip an extension out from
         * under a profile the user was not touching — a terminal breaking
         * because of something done in an unrelated one.
         *
         * So uninstall means "this profile stops loading it", which is what
         * the word means to the person typing it. Reclaiming the disk is its
         * own explicit act (`axon ext prune`), because deciding that no
         * profile needs a version any more is a different question from
         * deciding this one does not.
         *
         * A local entry (`./themes`, `~/dev/my-ext`) is the opposite: it is
         * source the user wrote, `uninstall` means "stop loading this", and
         * deleting it would be unrecoverable. So it is only ever undeclared.
         *
         * `resolveEntry` already distinguishes them, which is why this needs no
         * flag: the kind of the entry decides, not the caller's intent.
         */
        async uninstall(source: string): Promise<UninstallResult> {
            const root = opts.root()

            // Matched on NAME, so `axon ext uninstall @cody/vim` removes the
            // entry however it is pinned. Requiring the exact `@0.1.0` back
            // would make uninstall a lookup exercise, and the user is removing
            // the extension rather than one version of it.
            const declaredNow = await readEntries(root)
            const { name } = parseRef(source)
            const target = declaredNow.find(entry => parseRef(entry).name === name) ?? source

            const { changed } = await undeclareEntry(root, target)

            // Files are NEVER deleted here — see the note above. Reported as
            // `removed: false` always, so the CLI says what actually happened.
            return { changed, removed: false }
        },

        /**
         * What the profile declares, with the newest published version of each.
         *
         * ── Read-only, and that is the whole design ─────────────────────────
         *
         * An extension is arbitrary TypeScript that runs at module scope on
         * every boot with the full TUI API — it can bind keys, register
         * commands and drive the agent. So updating one is a privileged act
         * that stays MANUAL: nothing here fetches, writes or reloads. Asking
         * the registry what exists is safe; applying it is the user's call.
         *
         * That is also why there is no auto-update path to opt out of. A
         * background update would swap running code under a user mid-session,
         * and the pin in `profile.config.ts` is already a deliberate contract:
         * `store.resolve()` refuses to load a version the config does not name,
         * because "silently loading a version the config does not name is how a
         * pinned config stops meaning anything".
         *
         * LOCAL entries are excluded entirely. A `./my-ext` path is the user's
         * own source with no version and no publisher — there is nothing to
         * update it to, and offering it would be offering a row that cannot work.
         *
         * A name the registry cannot resolve (unpublished, renamed, network
         * down) is reported with `latest: null` rather than dropped, so a
         * caller can say so instead of quietly showing a shorter list.
         */
        async updates(): Promise<ExtensionUpdate[]> {
            if (!opts.latest) return []

            const root = opts.root()
            const entries = await readEntries(root)

            const checked = await Promise.all(entries.map(async (source): Promise<ExtensionUpdate | null> => {
                if (resolveEntry(source, root, store).kind === "local") return null

                const { name, version } = parseRef(source)
                try {
                    const latest = await opts.latest!(name)
                    // A COMPARISON, not an inequality. `latest !== version`
                    // reports any difference as "newer", so a registry serving
                    // an older version — a yank, a rollback, a staging
                    // endpoint — offered the user an "update" that was a
                    // downgrade. Unparseable versions on either side compare
                    // to false: unknown is not out of date.
                    const outdated = version !== null
                        && valid(version) !== null
                        && valid(latest) !== null
                        && gt(latest, version)
                    return { source, name, current: version, latest, outdated }
                } catch {
                    // Unreachable is not the same as up to date. Reported as
                    // unknown so the caller can distinguish "nothing new" from
                    // "could not ask" — a failed check that rendered as "up to
                    // date" would be a lie the user acts on.
                    return { source, name, current: version, latest: null, outdated: false }
                }
            }))

            return checked.filter((entry): entry is ExtensionUpdate => entry !== null)
        },

        /**
         * Move one extension to a version, and re-pin the config to it.
         *
         * Deliberately just `install()` at an explicit ref: an update IS an
         * install of a different version, and `addEntry` already replaces a
         * same-name entry rather than appending one — logic that exists for
         * precisely this ("re-installing after a publish produces a new ref").
         * A second code path would be the same operation written twice, free to
         * disagree about pinning.
         *
         * The version is REQUIRED rather than defaulted to latest. The caller
         * has already resolved and shown what it is moving to; re-resolving
         * here could silently land on something newer than the user agreed to
         * between the list rendering and their pressing enter.
         */
        async update(name: string, version: string): Promise<{ root: string; ref: string }> {
            const { root: installed, ref } = await this.install(formatRef(name, version))
            return { root: installed, ref }
        },

        /**
         * The sink the API implementation reports registrations to.
         *
         * Exposed because the two halves are built in different packages: the
         * globals live in the TUI (they need its composables), the ownership
         * bookkeeping lives here. `track()` on every register is the whole
         * coupling between them.
         */
        get disposers(): DisposerSink {
            return sink
        },

        /**
         * Load the profile and its extensions.
         *
         * Idempotent in the sense that matters: calling it again after
         * `unload()` produces a clean load. Calling it twice without one would
         * double-register, so `reload()` exists and this does not guard —
         * a silent no-op would be worse than the honest sequence.
         */
        async load(): Promise<ExtensionsResult> {
            const errors: unknown[] = []
            const sources: LoadedSource[] = []
            const root = opts.root()

            // The user's own config first — it wins every collision, and it
            // loads even when the extension list is unreadable.
            if (fsx.exists(root)) {
                sources.push(await loadSource({
                    root: root,
                    label: "profile",
                    sink: sink,
                    mainError: "PROFILE_MAIN_FAILED",
                }))
            }

            const config = await ProfileConfigFile(root, store)
            if (config.error) errors.push(config.error)

            // Sequential, deliberately — see the load-order note above.
            declared = config.entries.map(entry => entry.source)

            for (const entry of config.entries) {
                const problem = await materialize(entry)
                if (problem) {
                    errors.push(problem)
                    continue
                }
                sources.push(await loadSource({
                    root: entry.root,
                    label: entry.source,
                    sink: sink,
                    mainError: "EXTENSION_LOAD_FAILED",
                }))
            }

            loaded = sources
            return { sources, errors }
        },

        /**
         * Undo everything, newest source first.
         *
         * Reverse order for the same reason a source's own disposers run in
         * reverse: a later registration may have been made against state an
         * earlier one owns.
         */
        unload(): void {
            for (const source of [...loaded].reverse()) disposeSource(source)
            loaded = []
        },

        /**
         * Tear down and load again — what a config file change triggers.
         *
         * Unload FIRST, completely, before anything re-imports. Overlapping the
         * two would leave both generations registered at once, and every
         * collision would resolve against the old copy.
         */
        async reload(): Promise<ExtensionsResult> {
            this.unload()
            return this.load()
        },

        /**
         * Call `onChange` when the user's config changes on disk. Returns a
         * stop function.
         *
         * ── What is watched ─────────────────────────────────────────────────
         *
         * The profile root — `main.ts`, anything it imports, `plugins/`,
         * `profile.config.ts`, and each extension under `extensions/`.
         * Deliberately NOT `agents/` (each agent runs its own watcher, and an
         * agent's source is not terminal config), `store/` (Axon writes
         * history there continuously — a committed session event is not a
         * config change), or `.axon/` (generated BY the reload, so watching it
         * is a loop by construction).
         *
         * ── Why this notifies rather than reloads ───────────────────────────
         *
         * A reload here would be `this.reload()` — correct for the registry,
         * wrong for the terminal, which must also settle its input surface
         * first and fire `tui:boot`/`tui:reloaded` after. Two reload paths that
         * had to stay in step is exactly the drift this package avoids
         * elsewhere; the caller owns what a reload MEANS and this owns when.
         *
         * ── Why a reload's own writes must be DISCARDED ─────────────────────
         *
         * A reload writes inside the profile — an install's lockfile, a
         * regenerated frame. The watcher's own `during()` holds changes raised
         * while it runs and REPLAYS them on resume. That is right for a bounded
         * operation (an install writes, finishes, and replaying once catches a
         * user edit made alongside it) and wrong here, because the suspended
         * operation IS the reload: a replayed write starts another reload,
         * which writes, which replays. Unbounded, not a slow leak — and the
         * first thing a user would notice.
         *
         * So this gates at its own listener instead. Everything arriving while
         * a reload runs, plus a short tail afterwards, is dropped: fs
         * notifications are asynchronous, so a write made inside the reload is
         * still being delivered for a few milliseconds after it returns, and a
         * gate that closed the instant it finished would let exactly those
         * through.
         *
         * The cost is a real edit inside that window being missed. Bounded by
         * one save on an operation that is normally tens of milliseconds, and
         * recovered by the next save or `:reload`. The alternative is a
         * terminal that reloads forever, which is not a trade.
         */
        watch(onChange: () => Promise<void>): () => void {
            const watcher = Watcher({
                root: opts.root(),
                ignore: ["node_modules", ".git", ".axon", "agents", "store"],
                // The transient copies importFile() evaluates. Writing one is
                // part of performing a reload, so reacting to it would make
                // every reload schedule the next one, forever.
                ignoreFiles: name => name.startsWith(RELOAD_PREFIX),
                // An editor writes several times per save (temp file, rename,
                // mtime touch). Long enough to coalesce those, short enough
                // that saving still feels immediate.
                debounceMs: 150,
            })

            // How long after a reload returns its own writes may still be
            // arriving. Comfortably over the debounce, since a notification
            // scheduled just before the gate closes lands one window later.
            const TAIL_MS = 400

            // `selfReloads`: suppression must actually suppress. A bare
            // during() only DEFERS — the held change is delivered on resume,
            // so a `:theme set` still triggered the full config reload this
            // exists to avoid. The deaf-window below happened to absorb it,
            // but that is a 400ms race rather than a guarantee, and it broke
            // the moment a write took longer than the window.
            suppress = fn => watcher.during(fn, { selfReloads: true })

            let running = false
            let deafUntil = 0

            const stop = watcher.onChange(() => {
                if (running || Date.now() < deafUntil) return
                running = true
                void (async () => {
                    try {
                        await onChange()
                    } finally {
                        running = false
                        deafUntil = Date.now() + TAIL_MS
                    }
                })()
            })

            void watcher.start()
            return () => {
                suppress = null
                stop()
                watcher.stop()
            }
        },
    }
}

export type ExtensionsT = ReturnType<typeof Extensions>

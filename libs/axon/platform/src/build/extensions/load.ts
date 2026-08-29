import { copyFile, rm } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { dirname, extname, join } from "node:path"
import { err } from "@arcforge/err"
import type { Disposer } from "@arcforge/types"
import { fsx } from "../../utils/fs"

/**
 * Filename prefix for the transient copies `importFile` evaluates.
 *
 * Exported because the config WATCHER must ignore them: writing one is part of
 * performing a reload, so reacting to it would make every reload trigger the
 * next one. Named in one place so the two cannot disagree — a rename here that
 * the watcher did not learn about is an infinite reload loop.
 */
export const RELOAD_PREFIX = ".axon-reload-"

/**
 * How long one config file may take to evaluate before the load moves on.
 *
 * ── What this can and cannot do ─────────────────────────────────────────────
 *
 * It bounds how long a slow or hung file delays BOOT. It does not stop the
 * file: JavaScript cannot interrupt code mid-execution, so a synchronous
 * `while (true) {}` at module scope still owns the thread and no timer of any
 * kind will fire. Nothing here pretends otherwise — the error says the load
 * continued without it, not that it was cancelled.
 *
 * What it genuinely rescues is the common shape: a file awaiting something
 * that never resolves (a fetch with no timeout, a lock, a prompt on a stream
 * nobody is writing to). That yields to the event loop, so the budget fires,
 * the user gets a named error pointing at the file, and the terminal boots.
 *
 * Generous on purpose. A config that legitimately reads a file or resolves a
 * small import chain is well inside this; anything past it is not "slow", it
 * is stuck, and a user waiting on a black terminal has no way to learn why.
 */
const LOAD_BUDGET_MS = 10_000

/**
 * Loading one source — a profile, or one extension.
 *
 * A "source" is a directory containing a `main.ts` and/or a `plugins/` folder.
 * A profile and an extension are the same shape, which is the whole design:
 * an extension is a profile's config, packaged. So one loader serves both and
 * neither gets a capability the other lacks.
 *
 * ── Registration is a side effect of importing ──────────────────────────────
 *
 * There is no `setup()` and no default export to call. `commands.register(...)`
 * at module scope runs as the module body evaluates, so importing the file IS
 * loading it. That is what makes `main.ts` and a `plugins/` file identical to
 * write, and what makes a user's own config publishable unchanged.
 *
 * The cost is that a file which registers nothing is indistinguishable from one
 * that crashed before registering — so every failure is caught and reported per
 * file rather than being allowed to look like silence.
 */

/** What one file's load produced, or why it did not. */
export type LoadedFile = {
    /** Absolute path to the file. */
    path: string
    /** Null when it loaded. An AxonError describing the failure otherwise. */
    error: unknown | null
}

export type LoadedSource = {
    /** Absolute directory. */
    root: string
    /** How this source is named in errors — a profile says "profile", an extension says its entry. */
    label: string
    /** Every file this source contributed, in load order. */
    files: LoadedFile[]
    /** Disposers registered while this source was loading, in registration order. */
    disposers: Disposer[]
}

/**
 * Collects the disposers a source registers while it loads.
 *
 * The API implementation calls `track()` from inside every `register`/`create`,
 * so nothing in the contract has to be reshaped to make teardown work — a
 * global `commands.register(...)` returns its disposer to the user AND hands a
 * copy here, and the loader knows which source it belongs to because only one
 * loads at a time.
 */
export type DisposerSink = {
    /** Begin attributing disposers to this source. */
    open(): void
    /** Stop attributing, returning everything registered since open(). */
    close(): Disposer[]
    /** Called by the API implementation on every registration. */
    track(dispose: Disposer): void
}

export function DisposerSink(): DisposerSink {
    let current: Disposer[] | null = null

    return {
        open(): void {
            current = []
        },
        close(): Disposer[] {
            const collected = current ?? []
            current = null
            return collected
        },
        track(dispose: Disposer): void {
            // Outside a load — a registration made later from a hook or a
            // command. Nothing owns it, so nothing disposes it; the caller
            // holds the disposer it was returned.
            current?.push(dispose)
        },
    }
}

/**
 * Import one file for its side effects, re-evaluating it every time.
 *
 * ── Why this is not `import(path + "?t=" + uuid)` ───────────────────────────
 *
 * That is the Node idiom, it was what this did, and under Bun it does
 * NOTHING. Bun keys its ESM cache on the resolved file path and discards the
 * query string, so every reload after the first was served the cached module
 * and no top-level registration re-ran.
 *
 * The failure was silent and total: `reload()` is unload-then-load, the unload
 * half worked perfectly, and the load half re-imported nothing. So a reload
 * DESTROYED the user's commands, keybinds, status lines and themes and never
 * brought them back — with an empty error list, because nothing threw. On a
 * real profile: 11 themes registered on load, 0 on reload.
 *
 * A symlink does not work either — Bun resolves it with realpath, arriving at
 * the same cache key. What does work is a real copy at a path nothing has
 * imported before.
 *
 * ── Why the copy sits BESIDE the original ───────────────────────────────────
 *
 * The user's file may import its own siblings (`./lib`, `../shared`), and a
 * relative specifier resolves against the importing file's directory. Copying
 * to a temp dir would break every one of them. A dotted, uuid-named neighbour
 * resolves identically to the original and is removed immediately after.
 *
 * `.axon-reload-*` is in the config watcher's ignore list, so writing it here
 * cannot trigger the reload that is already running.
 */
async function importFile(path: string): Promise<void> {
    const copy = join(dirname(path), `${RELOAD_PREFIX}${crypto.randomUUID()}${extname(path)}`)
    await copyFile(path, copy)
    try {
        await import(pathToFileURL(copy).href)
    } catch (cause) {
        // The copy's path is an implementation detail of reloading, and it is
        // DELETED a moment later — so a stack naming it points the user at a
        // file that does not exist, for an error in a file that does. Rewritten
        // back to the real path, because "where is my mistake" is the entire
        // value of this error.
        throw restack(cause, copy, path)
    } finally {
        // Best-effort: a leftover copy is inert (it is ignored by the watcher
        // and imported by nothing), and failing a config load over a temp file
        // that would not delete is the wrong trade.
        await rm(copy, { force: true }).catch(() => {})
    }
}

/** What `withBudget` throws when a file outlives the budget. */
type Timeout = { axonLoadTimeout: true; error: unknown }

function isTimeout(value: unknown): value is Timeout {
    return typeof value === "object" && value !== null && "axonLoadTimeout" in value
}

/**
 * Run one file's import against the load budget.
 *
 * The import is NOT cancelled when the budget expires — it cannot be, and the
 * module may still register things afterwards. What is bounded is how long the
 * loader waits before reporting and moving on, which is the difference between
 * a terminal that boots degraded with a named error and one that never boots
 * at all.
 *
 * A late rejection from an abandoned import is swallowed deliberately: the
 * file has already been reported as timed out, and a second error about the
 * same file — arriving after the load finished, as an unhandled rejection —
 * would be noise at best and a crash at worst.
 */
async function withBudget<T>(path: string, run: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject({
                axonLoadTimeout: true,
                error: err("EXTENSION_LOAD_TIMEOUT", {
                    detail: `${path} did not finish loading within ${LOAD_BUDGET_MS / 1000}s`,
                    context: { path, budgetMs: LOAD_BUDGET_MS },
                }),
            } satisfies Timeout)
        }, LOAD_BUDGET_MS)
    })

    const attempt = run()
    // Attached before the race so an import that rejects AFTER losing it does
    // not surface as an unhandled rejection.
    attempt.catch(() => {})

    try {
        return await Promise.race([attempt, budget])
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Point an error's message and stack back at the file the user actually wrote.
 *
 * Mutates rather than wrapping: the cause is handed to the caller as-is and
 * rendered by whoever reports it, so a wrapper would have to be unwrapped by
 * every reader to find the real message. Both fields are rewritten because
 * Bun puts the path in each, and a message still naming the temp copy is the
 * half a user reads first.
 */
function restack(cause: unknown, from: string, to: string): unknown {
    if (typeof cause !== "object" || cause === null) return cause
    const swap = (text: string): string => text.split(from).join(to)

    // Bun reports an unresolvable import as a `ResolveMessage`, which is NOT
    // an Error and whose text comes from engine-internal state: assigning
    // `.message` appears to succeed and changes nothing that any reader sees
    // (`String(e)` still names the copy), and it carries the path a second
    // time in `.referrer`. A typo'd `./sibling` is the most common config
    // mistake there is, so this cannot be left pointing at a deleted file.
    //
    // Converted to a real Error rather than patched: it is the only way the
    // corrected text survives every way a caller might render it.
    const named = cause as { name?: unknown; message?: unknown; stack?: unknown }
    if (named.name === "ResolveMessage") {
        const rebuilt = new Error(swap(String(cause)))
        rebuilt.name = "ResolveMessage"
        // The original stays reachable for anything that wants the structured
        // fields (`specifier`, `importKind`) — nothing is discarded, only the
        // rendering is corrected.
        rebuilt.cause = cause
        return rebuilt
    }

    try {
        if (typeof named.message === "string") named.message = swap(named.message)
        if (typeof named.stack === "string") named.stack = swap(named.stack)
    } catch {
        // A frozen or getter-only value — nothing to rewrite, and the original
        // is still more useful than failing here. Rethrown unchanged.
    }
    return cause
}

/** Every `.ts` in `plugins/`, alphabetical. Missing folder → nothing. */
async function pluginFiles(root: string): Promise<string[]> {
    const dir = join(root, "plugins")
    if (!fsx.exists(dir)) return []

    const names = await fsx.list(dir)
    return names
        .filter(name => name.endsWith(".ts"))
        .sort()
        .map(name => join(dir, name))
}

type LoadSourceOpts = {
    root: string
    label: string
    sink: DisposerSink
    /** Which error names a failing main.ts — a profile's and an extension's differ. */
    mainError: "PROFILE_MAIN_FAILED" | "EXTENSION_LOAD_FAILED"
}

/**
 * Load one source: `main.ts`, then every file in `plugins/` alphabetically.
 *
 * ── Per-file containment ────────────────────────────────────────────────────
 *
 * A throwing file disables ITSELF and nothing else. Its siblings still load,
 * and whatever it registered before throwing stays registered — a partially
 * loaded file is not rolled back, because the registrations that succeeded are
 * real and removing them would surprise a user whose command exists in a file
 * that later has a typo.
 *
 * The alternative — failing the whole source — is more predictable but punishes
 * far more: one bad plugin would cost a user every command in their config, at
 * the exact moment they need the terminal to go fix it.
 *
 * ORDER is main.ts first, deliberately. It is the file a user thinks of as
 * their config, and the one that may `import "./keybindings"` — so anything it
 * pulls in is registered before any plugin hook can fire.
 */
export async function loadSource(opts: LoadSourceOpts): Promise<LoadedSource> {
    const { root, label, sink, mainError } = opts

    sink.open()
    const files: LoadedFile[] = []

    /** Import one file under the budget, recording success or the reason not. */
    async function loadFile(path: string, failure: "PROFILE_MAIN_FAILED" | "EXTENSION_LOAD_FAILED" | "PLUGIN_FAILED"): Promise<void> {
        try {
            await withBudget(path, () => importFile(path))
            files.push({ path, error: null })
        } catch (cause) {
            if (isTimeout(cause)) {
                files.push({ path, error: cause.error })
                return
            }
            files.push({
                path,
                error: err(failure, {
                    detail: `${path} — ${cause instanceof Error ? cause.message : String(cause)}`,
                    context: { path, source: label },
                    cause,
                }),
            })
        }
    }

    const main = join(root, "main.ts")
    if (fsx.exists(main)) await loadFile(main, mainError)

    for (const path of await pluginFiles(root)) await loadFile(path, "PLUGIN_FAILED")

    return { root, label, files, disposers: sink.close() }
}

/**
 * Undo one source's registrations.
 *
 * Reverse order, so a disposer registered later cannot depend on state a
 * disposer registered earlier has already torn down. A throwing disposer must
 * not strand the rest — teardown runs to completion and reports nothing, since
 * there is no user action to take about a failed unregistration.
 */
export function disposeSource(source: LoadedSource): void {
    for (const dispose of [...source.disposers].reverse()) {
        try {
            dispose()
        } catch {
            // Deliberately swallowed. Teardown is bookkeeping the user did not
            // ask for; a failure here is ours, and reporting it during a reload
            // would blame them for it. The remaining disposers still run.
        }
    }
}

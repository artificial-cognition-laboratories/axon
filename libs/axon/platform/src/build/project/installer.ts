import { HttpError, resolveDefaultBaseUrl, type AxonCloudClient } from "@arcforge/cloud"
import { err } from "@arcforge/err"
import type { ManifestT } from "./manifest"
import type { TreeT } from "./tree"
import { parseSpecifier } from "./specifier"

/**
 * Installer — add and remove registry modules from an agent.
 *
 * Three writes and a `bun install`. Axon decides WHAT the agent has;
 * Bun decides how those bytes arrive:
 *
 *   package.json    the dependency (semver range)  — presence
 *   axon.config.ts  the module entry               — activation
 *   bun.lock        the exact resolved version     — Bun's, not ours
 *
 * That split is Nuxt's: a module is both a dependency and a declared
 * feature, and those are genuinely different facts. A package can be
 * installed but not activated.
 *
 * This used to be a hand-rolled package manager — download, extract,
 * sha256, a bespoke lockfile, a parallel .agent/modules store, symlinks
 * into node_modules, and a flat dependency hoister that threw on version
 * conflicts Bun resolves by nesting. All of it existed only because Bun
 * did not know where Axon modules came from. It does now (see the npm
 * protocol surface in the backend), so all of it is gone.
 */

export type InstallResult =
    | { status: "installed"; name: string; version: string }
    | { status: "already-installed"; name: string; version: string }
    /**
     * No such module in the registry — a mistyped or unpublished name.
     * Separate from "error" because it is not a fault: nothing is broken,
     * the thing asked for simply does not exist. Callers report it as
     * information; only a real failure (network, disk, a broken install)
     * deserves to be raised as one.
     */
    | { status: "not-found"; name: string }
    | { status: "error"; name: string; error: string }

/**
 * `source-declared` is a REFUSAL, not a failure: the module is declared by an
 * import statement in axon.config.ts rather than by a registry name, and that
 * import is the author's own code. Uninstall does not rewrite it, so it
 * removes nothing at all — touching package.json alone would strip the
 * dependency while the config still imported it, and the agent would keep
 * loading a module whose package was gone.
 *
 * `path` names the file to edit, because "remove it by hand" is only
 * actionable if the user is told where.
 */
export type UninstallResult =
    | { status: "removed" | "not-installed"; name: string }
    | { status: "source-declared"; name: string; path: string }

/**
 * One module's position relative to the registry — what `updates()` reports
 * and an update surface renders.
 *
 * `current` and `range` are both here because they answer different questions,
 * and conflating them is the mistake this type exists to prevent. See
 * `updates()`.
 */
export type ModuleUpdate = {
    name: string
    /** The declared constraint in package.json — `^1.2.0`, `~1.2.0`, `1.2.0`. */
    range: string
    /**
     * The version materialized in node_modules — what the agent actually
     * loads. Null when the module is declared but not installed.
     */
    current: string | null
    /** Newest published. Null when the registry could not be reached. */
    latest: string | null
    /**
     * True only when both versions are known and differ. An unknown on either
     * side is never an update — see `updates()` for why each is reported as
     * itself instead.
     */
    outdated: boolean
}

export type InstallOptions = {
    /**
     * Register the package in axon.config.ts's modules array. Default true.
     * False for dependencies that are not modules — notably the cognet.
     */
    declare?: boolean
    /**
     * Re-resolve to the registry's latest on every install, overwriting the
     * declared range instead of respecting it as a pin.
     *
     * Only for dependencies the user did NOT choose — today just the default
     * cognet. An unchosen default should not silently freeze at whatever was
     * current when the agent was scaffolded, and it must not be poisonable:
     * a range that cannot resolve (a workspace sibling's version leaking into
     * package.json, say) would otherwise be honoured forever and surface to
     * the user as a boot failure.
     *
     * Never set this for something the user asked for by name. An explicit
     * `cognet: "@axon/zero@0.1.4"` is a pin and stays one.
     */
    track?: "latest"
    /**
     * Resolve only versions targeting this kernel ABI.
     *
     * For the cognet, whose bundle is fused to one kernel contract: "latest" on
     * its own can name a version this runtime cannot load, and the mismatch
     * would otherwise surface after install, at compile time. Passing the ABI
     * means an incompatible version is never selected in the first place.
     *
     * Has no effect on an explicitly pinned specifier — the registry honours
     * the pin and the prepare-time ABI gate is what refuses a bad pairing,
     * naming the file to edit.
     */
    abi?: string
    /**
     * Write the resolved version back under the range OPERATOR the manifest
     * already declares (`^1.2.0` → `^1.3.0`), instead of as the exact pin an
     * explicit constraint normally produces.
     *
     * Exists for `update()`. An explicit constraint is written through
     * verbatim, so without this, moving a module to 1.3.0 lands `1.3.0` in
     * package.json and silently converts the user's caret range into a hard
     * pin. They asked to move a version, not to stop receiving patches, and
     * the loss surfaces much later as a module that stopped tracking. A name
     * with no declared operator was a deliberate exact pin and stays exact.
     *
     * Never set for a constraint the USER typed: `axon install @x/y@1.2.0`
     * means that version, and widening it would install something else.
     */
    keepRange?: boolean
}

type InstallerOpts = {
    root: string
    cloud: AxonCloudClient
    /** The project's declaration files — what install adds a dependency to. */
    manifest: ManifestT
    /** The installed node_modules — what install materializes. */
    tree: TreeT
    /**
     * Runs `fn` with the project's file watcher suspended.
     *
     * An install rewrites the manifests AND node_modules; the watcher would
     * see the manifest writes and fire a reload into the middle of the tree
     * rebuild. A thunk rather than the Watcher handle because Watcher() is
     * constructed after Installer() in project.ts — same idiom as the bench
     * axis and Zeno's clone.
     */
    during: <T>(fn: () => Promise<T>, options?: { selfReloads?: boolean }) => Promise<T>
    /** Backend base URL — where the agent's registry scopes point. Defaults to this process's backend. */
    apiBase?: string
}

export function Installer(opts: InstallerOpts) {
    const { cloud, manifest, tree } = opts
    /** Where bun fetches tarballs from. */
    const registryUrl = `${opts.apiBase ?? resolveDefaultBaseUrl()}/api/registry/npm/-`
    /**
     * Which registry auto-resolved ranges are attributed to.
     *
     * The API BASE rather than the npm sub-path, because that is the identity
     * of the registry as a whole — the same base answers both the resolve
     * endpoint that produces a range and the npm endpoint that serves the
     * tarball, and comparing bases is what tells staging from production.
     */
    const registryOrigin = opts.apiBase ?? resolveDefaultBaseUrl()

    /**
     * Confirm the module exists and pin the range against a real published
     * version. Bun would fail on a missing package anyway, but its error
     * speaks about a registry URL; resolving first lets a bad specifier
     * fail as an Axon error naming the module.
     */
    async function resolveVersion(name: string, constraint?: string, abi?: string): Promise<string> {
        const resolved = await cloud.registry.artifacts.resolve(name, constraint, abi ? { abi } : undefined)

        // A prompt is not installable into an agent. Prompts are content a
        // person picks off a palette: they resolve into a global cache and
        // render on the spot, so no agent ever depends on one. Declaring it
        // in modules: [...] instead would put content through the code path —
        // an ABI check, a node_modules link and an agent reload — for
        // something that needs none of them.
        if (resolved.kind === "prompt") {
            throw err("PROMPT_NOT_INSTALLABLE", {
                detail: `"${name}" is a prompt, not a module. Prompts are not installed into an agent — they resolve from the global cache and render on demand, so any agent can use one without declaring it.`,
                context: { name },
            })
        }

        return resolved.version
    }

    return {
        /**
         * Ensure every specifier is a dependency of this agent and declared
         * in its config, then materialize node_modules once for the batch.
         *
         * `declare: false` installs the dependency WITHOUT adding it to the
         * config's modules array — how a cognet is installed. A cognet is a
         * dependency of the agent but not a module of it: it is selected by
         * `cognet:`, and listing it under `modules:` would try to load the
         * brain as a capability bundle.
         */
        /**
         * Re-resolve any auto-written range that came from a DIFFERENT registry.
         *
         * Must run before anything calls `tree.install()`, and that ordering is
         * the whole point. Bun resolves the WHOLE manifest at once, so a single
         * unresolvable range fails the install of every other package — a
         * poisoned `@axon/zero` range killed the modules install long before
         * the cognet step that would have re-resolved it ever ran. Fixing it
         * per-install-path is therefore not enough; the manifest has to be
         * coherent before the first install, not after the one that owns it.
         *
         * Only ranges Axon wrote itself (`axon.trackedFrom`) are touched. A
         * user's pin carries no origin and is never second-guessed.
         *
         * Returns the names it repaired, for the caller to report.
         */
        async repairForeignRanges(): Promise<Array<{ name: string; from: string; to: string; origin: string }>> {
            const origins = await manifest.package.dependencies.trackedFrom()
            const foreign = Object.entries(origins).filter(([, origin]) => origin !== registryOrigin)
            if (foreign.length === 0) return []

            const declared = await manifest.package.dependencies.all()
            const additions: Record<string, string> = {}
            const stamps: Record<string, string> = {}
            const repaired: Array<{ name: string; from: string; to: string; origin: string }> = []

            for (const [name, origin] of foreign) {
                const existing = declared[name]
                if (existing === undefined) continue
                try {
                    // No constraint: this range was auto-resolved to begin
                    // with, so re-resolving is restoring it, not overriding a
                    // choice. No ABI either — the caller that owns the ABI
                    // constraint (the cognet path) re-resolves under it
                    // immediately after, and guessing one here could pick a
                    // version that path would reject.
                    const version = await resolveVersion(name)
                    const range = `^${version}`
                    stamps[name] = registryOrigin
                    if (range !== existing) {
                        additions[name] = range
                        repaired.push({ name, from: existing, to: range, origin })
                    }
                } catch {
                    // Unresolvable here too. Left alone deliberately: the
                    // install that follows fails with the package manager's own
                    // message, which is more specific than anything this could
                    // invent about a package it could not reach.
                }
            }

            if (Object.keys(additions).length > 0 || Object.keys(stamps).length > 0) {
                await manifest.package.dependencies.set(additions, stamps)
            }
            return repaired
        },

        async install(specifiers: string[], options: InstallOptions = {}): Promise<InstallResult[]> {
            if (specifiers.length === 0) return []

            // Read once, decide across the whole batch, then hand the
            // additions to Manifest in one write — several specifiers commonly
            // resolve in one call, and each is a decision about the same map.
            const declared = await manifest.package.dependencies.all()
            // Which registry each existing auto-resolved range came from, so a
            // range derived elsewhere can be re-resolved rather than honoured
            // into a permanent failure.
            const origins = await manifest.package.dependencies.trackedFrom()
            const trackedOrigin = (name: string): string | undefined => origins[name]
            const additions: Record<string, string> = {}
            const trackedOrigins: Record<string, string> = {}
            const results: InstallResult[] = []

            for (const specifier of specifiers) {
                // Inside the try: a malformed specifier is one bad entry in
                // the batch, reported like any other per-specifier failure,
                // not something that aborts the whole install.
                let name = specifier
                try {
                    // An unscoped name can never resolve, so it is the same
                    // outcome as a name that doesn't exist: nothing found.
                    if (!specifier.startsWith("@")) {
                        results.push({ status: "not-found", name })
                        continue
                    }

                    const parsed = parseSpecifier(specifier)
                    name = parsed.name
                    const constraint = parsed.version
                    const existingRange = declared[name] ?? additions[name]
                    // A `file:` dependency is a LOCAL source module, not a
                    // registry install. Asking to install from the registry
                    // is asking to replace it, so it must not count as
                    // already-installed — otherwise the local copy wins
                    // forever and the registry version can never land.
                    //
                    // `workspace:*` is the same situation with a worse failure
                    // mode. An agent inside a monorepo can acquire one (a bare
                    // `bun update` rewrites the range when a workspace member
                    // shares the name), and installDependencies() resolves
                    // against an ISOLATED copy of this manifest where no
                    // workspace exists — so it doesn't just shadow the
                    // registry version, it can't resolve at all. Treat it as
                    // absent so the registry range replaces it.
                    const isLocalRange = existingRange?.startsWith("file:") || existingRange?.startsWith("workspace:")
                    const existing = isLocalRange ? undefined : existingRange

                    // An unconstrained install of an already-declared module
                    // leaves its range alone. Re-resolving to latest here
                    // would turn `axon install x` into a silent upgrade of a
                    // version someone deliberately pinned — only an explicit
                    // constraint may move a pin. The declared range is the
                    // answer, so this asks the registry nothing: it is a
                    // range ("^0.1.0"), not a version the registry could
                    // resolve anyway.
                    // `track: "latest"` skips this: the whole point is to
                    // re-resolve and overwrite the declared range, so treating
                    // it as an untouchable pin is exactly the wrong answer.
                    if (existing !== undefined && !constraint && options.track !== "latest") {
                        // …unless the range was auto-resolved against a
                        // DIFFERENT registry than the one now configured. Such
                        // a range describes a version this registry may never
                        // have heard of, and honouring it means every install
                        // from here on fails to resolve. Re-resolving is the
                        // only way back, and it is safe precisely because the
                        // range was never the user's claim — we wrote it.
                        const origin = trackedOrigin(name)
                        if (origin !== undefined && origin !== registryOrigin) {
                            // Fall through to re-resolve against this registry.
                        } else {
                            results.push({ status: "already-installed", name, version: existing.replace(/^[\^~>=<\s]*/, "") })
                            continue
                        }
                    }

                    const version = await resolveVersion(name, constraint, options.abi)
                    // `keepRange` re-applies the operator already declared, so
                    // an update moves the version without narrowing the user's
                    // constraint into a pin. See InstallOptions.
                    const range = options.keepRange && constraint
                        ? `${existingRange?.match(/^[\^~]/)?.[0] ?? ""}${version}`
                        : constraint ?? `^${version}`

                    if (existing === range) {
                        results.push({ status: "already-installed", name, version })
                        continue
                    }

                    // A range written here is derived from ONE registry, but it
                    // is stored in a manifest that outlives the session and is
                    // read by every later install, whichever registry is
                    // configured then. Those are not the same fact, and nothing
                    // in package.json records the difference.
                    //
                    // The failure this closes, observed: a `track: "latest"`
                    // resolve ran against local staging (which had @axon/zero
                    // 1.0.5 from test publishes), wrote "^1.0.5" into a real
                    // agent's package.json, and every subsequent install
                    // against PRODUCTION — whose latest is 1.0.4 — failed to
                    // resolve. The manifest permanently demanded a version that
                    // only ever existed on one machine's localhost.
                    //
                    // Recording the origin costs one field and makes the
                    // mismatch detectable instead of mysterious. Only tracked
                    // (auto-resolved) ranges are stamped: a range the USER
                    // pinned is their claim, not ours, and must not be
                    // second-guessed by which registry happens to be current.
                    if (options.track === "latest") {
                        trackedOrigins[name] = registryOrigin
                    }

                    additions[name] = range
                    results.push({ status: "installed", name, version })
                } catch (error) {
                    // A 404 from resolve means no such module — the user
                    // mistyped, or it was never published. Not a fault.
                    if (error instanceof HttpError && error.status === 404) {
                        results.push({ status: "not-found", name })
                        continue
                    }
                    results.push({ status: "error", name, error: error instanceof Error ? error.message : String(error) })
                }
            }

            // Everything from here rewrites the project: three manifest files
            // and then node_modules. Suspended as ONE span so the watcher
            // cannot fire a reload between the manifest writes and the tree
            // rebuild — the window where package.json declares a dependency
            // the tree has not materialized yet, and a rescan sees an
            // incoherent project. The caller reloads once when this returns.
            //
            // `selfReloads` is what makes that "once" true. Suspension alone
            // only DEFERS the notification — it is delivered on resume, so the
            // caller's reload and the watcher's fired back to back and every
            // install rescanned the whole project twice.
            return opts.during(async () => {
                const changed = Object.keys(additions).length > 0 || Object.keys(trackedOrigins).length > 0
                if (changed) {
                    await manifest.package.dependencies.set(additions, trackedOrigins)
                    // Bun resolves by scope, so a namespace it has never seen
                    // (any user or org publishing here) must be mapped before
                    // the install runs or it asks npmjs.com and 404s. Only the
                    // scopes actually resolved through Axon are mapped —
                    // everything else must keep resolving against public npm.
                    const resolved = results
                        .filter(r => r.status === "installed" || r.status === "already-installed")
                        .map(r => r.name)
                    await manifest.bunfig.ensureAll(resolved, registryUrl)
                    if (options.declare !== false) {
                        for (const result of results) {
                            if (result.status === "installed") {
                                await manifest.config.add(result.name, "modules")
                            }
                        }
                    }
                }

                // Materialize node_modules only when there's a real reason to:
                // the manifest actually changed (a new install), OR node_modules
                // is missing (a previous run wrote the manifest then failed before
                // installing, so "already-installed" would otherwise mean "declared
                // but absent"). A warm boot where everything is already declared
                // AND present must NOT run `bun install` — that no-op install was
                // costing ~1.5s on every `axon dev` / TUI boot.
                const anyResolved = results.some(r => r.status === "installed" || r.status === "already-installed")
                if (anyResolved && (changed || !tree.frameworkInstalled())) {
                    await tree.install()
                }

                return results
            }, { selfReloads: true })
        },

        /**
         * Drop a registry module from this agent's dependencies and config.
         *
         * A malformed specifier reports "not-installed" rather than
         * throwing: nothing by that name is installed, which is exactly
         * what the caller asked about. Removing something absent is not a
         * failure, and a mistyped name is a user correcting themselves —
         * not a fault the UI should render as a crash.
         */
        async uninstall(specifier: string): Promise<UninstallResult> {
            let name: string
            try {
                ; ({ name } = parseSpecifier(specifier))
            } catch {
                return { status: "not-installed", name: specifier }
            }

            // Suspended for the same reason install() is: the manifest writes
            // and the tree rebuild are one transition, and a reload landing
            // between them rescans a project whose files and node_modules
            // disagree. `selfReloads` for the same reason too — the caller
            // reloads when a removal actually happened.
            return opts.during(async () => {
                // BEFORE any write. A source-declared module is one this
                // uninstall cannot complete — `config.remove()` matches the
                // registry NAME as a string, and a source module's declaration
                // is an import binding, so it would find nothing and report
                // false. That false used to be discarded: the dependency came
                // out of package.json, the import stayed, and the whole thing
                // reported "removed" while the agent went right on loading the
                // module from a package it no longer declared.
                //
                // Refusing here keeps the two manifests consistent — either
                // both change or neither does.
                if (!(await manifest.config.declaresName(name))) {
                    return { status: "source-declared" as const, name, path: manifest.config.path }
                }

                const removed = await manifest.package.dependencies.remove([name])
                if (removed.length === 0) return { status: "not-installed" as const, name }
                // Which array it lives in is a property of the file, not of the
                // caller — remove() drops the declaring line wherever it sits, so
                // uninstall never needs to know the kind.
                await manifest.config.remove(name)
                await tree.install()

                return { status: "removed" as const, name }
            }, { selfReloads: true })
        },

        /**
         * The registry artifacts this agent declares, as name → version range.
         *
         * An installed artifact is a dependency the agent's config also
         * ACTIVATES, so that is the test. Filtering on "@" alone would
         * count every scoped npm package (@vue/compiler-sfc, @types/bun) as
         * installed — the same conflation between "a dependency" and "a
         * module" that put npm internals into the agent's tool scope.
         *
         * Modules are the whole set: prompts are no longer installable into
         * an agent at all. They resolve from the global cache and render on
         * demand, so nothing about a prompt is a property of one agent.
         */
        /**
         * The newest published version of one artifact, optionally constrained
         * and optionally gated to a kernel ABI.
         *
         * Exposed for the cognet, which resolves ONE package rather than the
         * declared-module set `updates()` walks, and must pass an ABI so a
         * version this runtime cannot load is never selected. Throws when the
         * registry cannot answer — callers decide whether that is a row saying
         * "could not reach the registry" or a failure.
         */
        resolve(name: string, constraint?: string, abi?: string): Promise<string> {
            return resolveVersion(name, constraint, abi)
        },

        async installed(): Promise<Record<string, string>> {
            const dependencies = await manifest.package.dependencies.all()
            const activated = new Set(await manifest.config.declared("modules"))
            return Object.fromEntries(
                Object.entries(dependencies).filter(([name]) => activated.has(name)),
            )
        },

        /**
         * This agent's modules, each with the newest published version.
         *
         * Read-only, deliberately: nothing here fetches a tarball, writes a
         * manifest or rebuilds a tree. Asking the registry what exists is safe
         * and happens on a palette render; applying it is `update()`.
         *
         * ── `current` is the TREE, not the range ────────────────────────────
         *
         * An extension is pinned exactly in `profile.config.ts`, so "what am I
         * on" is a string in a config and "outdated" is a string compare. A
         * module is a semver RANGE in package.json resolved to an exact version
         * in bun.lock, and those are not the same fact. `^1.2.0` with 1.2.7 on
         * disk is current at 1.2.7 — reading the range's floor would report an
         * update `prepare` had already applied, every time, for every module
         * anyone ever installed with a caret.
         *
         * So `current` is `tree.installedVersion()` — what the agent actually
         * loads — and `range` rides alongside, because an update that crosses
         * the declared range rewrites the user's constraint and a surface has
         * to be able to say so.
         *
         * ── Two unknowns, each reported as itself ───────────────────────────
         *
         * `current: null` is declared-but-not-materialized (a fresh clone
         * before `prepare`). That is a missing install, not an update, and
         * rendering it as outdated sends the user to the wrong fix.
         *
         * `latest: null` is a registry that could not be reached. Kept as a row
         * rather than dropped, because "could not ask" and "nothing new" look
         * identical from the outside and mean opposite things — a failed check
         * shown as up to date is the one wrong reading that costs something.
         *
         * Neither is ever `outdated`, so a caller that only reads that flag
         * cannot act on a version it does not know.
         */
        async updates(): Promise<ModuleUpdate[]> {
            const declared = await this.installed()

            return await Promise.all(Object.entries(declared).map(async ([name, range]): Promise<ModuleUpdate> => {
                const current = tree.installedVersion(name)
                try {
                    const latest = await resolveVersion(name)
                    return { name, range, current, latest, outdated: current !== null && latest !== current }
                } catch {
                    return { name, range, current, latest: null, outdated: false }
                }
            }))
        },

        /**
         * Move modules to explicit versions, in ONE transition.
         *
         * ── A batch, not a loop ─────────────────────────────────────────────
         *
         * `install()` already reads the manifest once, decides across the whole
         * set, writes once and runs `bun install` once — all under a single
         * watcher suspension. Updating three modules one at a time would
         * rebuild node_modules three times to reach the state the batch reaches
         * once, with the agent reloading between each.
         *
         * This is where modules and extensions genuinely differ. Extensions
         * update sequentially because each is a separate AST edit to one shared
         * `profile.config.ts`, and two of those racing is how one silently
         * loses. Modules write one manifest as a unit, so the batch is both
         * faster and the safer shape.
         *
         * ── Just install(), at explicit refs ────────────────────────────────
         *
         * An update IS an install of a different version. The pinning, the
         * registry-origin bookkeeping, the already-installed short circuit —
         * all of it is what an update needs, and a second code path would be
         * the same operation written twice, free to disagree about any of it.
         *
         * Versions are REQUIRED, never defaulted to latest: the caller has
         * already resolved and shown the user what it is moving to, and
         * re-resolving here could land somewhere newer than they agreed to
         * between the list rendering and their pressing enter.
         *
         * `keepRange` is what stops the write narrowing the manifest — the
         * exact version drives resolution, the declared operator survives.
         */
        async update(targets: Array<{ name: string; version: string }>): Promise<InstallResult[]> {
            return await this.install(
                targets.map(target => `${target.name}@${target.version}`),
                { keepRange: true },
            )
        },
    }
}

export type InstallerT = ReturnType<typeof Installer>

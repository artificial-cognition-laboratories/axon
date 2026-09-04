import { dirname, isAbsolute, join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { cp, mkdir, mkdtemp, readdir, readlink, rename, rm, symlink } from "node:fs/promises"
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { err } from "@arcforge/err"
import { graftBroken, verify, type VerifyReport } from "./verify"
import { TreeCache } from "./treecache"
import { resolveAbsoluteLinks } from "./links"
import { isPropagationLag, withPropagationRetry } from "./propagation"
import type { ManifestT } from "./manifest"

type TreeOpts = {
    root: string
    /** Override the shared tree cache. Tests point this at a temp dir. */
    cache?: { root?: string; max?: number }
}

/**
 * Tree — the project's installed node_modules.
 *
 * The counterpart to Manifest: where Manifest owns what the project DECLARES,
 * this owns what is actually materialized on disk. One sentence: it asks Bun to
 * resolve the manifest and puts the result where the project can see it.
 *
 * Every dependency question is answered here. Merging module dependencies into
 * the agent, reconciling conflicting semver ranges, and linking a parallel
 * module store all used to live in this concern; each was compensation for Bun
 * not knowing where Axon modules came from. It does now (the registry speaks
 * the npm protocol), so a module's dependencies are simply its own package.json
 * dependencies, and two modules wanting incompatible versions of the same
 * package resolve by nesting rather than throwing a conflict the user could not
 * act on.
 */
export function Tree(opts: TreeOpts) {
    const root = opts.root
    // The machine-wide resolved-tree cache. Injectable so tests never touch
    // the developer's real one.
    const cache = TreeCache(opts.cache ?? {})

    /**
     * Walk up from the project root looking for an installed package, as a
     * resolver would.
     *
     * Deliberately NOT Bun.resolveSync: that also resolves through bun's GLOBAL
     * install cache (~/.bun/install/cache), so it returns true for a project
     * with an empty node_modules whose version merely happens to be cached.
     * That false positive skipped the install and left the agent unrunnable.
     */
    function resolves(name: string): boolean {
        let dir = resolve(root)
        while (true) {
            if (existsSync(join(dir, "node_modules", ...name.split("/")))) return true
            const parent = dirname(dir)
            if (parent === dir) return false
            dir = parent
        }
    }

    /**
     * The directory a package resolved to, or null. Same walk as resolves(),
     * kept separate so callers that need the path do not repeat it.
     */
    function locate(name: string): string | null {
        let dir = resolve(root)
        while (true) {
            const candidate = join(dir, "node_modules", ...name.split("/"))
            if (existsSync(candidate)) return candidate
            const parent = dirname(dir)
            if (parent === dir) return null
            dir = parent
        }
    }

    /**
     * What is actually installed for `name` — its version, read from the
     * package.json on disk. Null when absent or unreadable.
     *
     * The distinction resolves() cannot make. A directory being present was
     * the entire installed-ness test, so a package that was present but WRONG
     * — an older version than the range now permits, or one whose contents
     * were replaced — passed as installed. That is how an agent stayed pinned
     * to a broken 0.1.0 after 0.1.1 was published to fix it: the directory
     * existed, so nothing ever looked closer.
     */
    function installedVersion(name: string): string | null {
        const dir = locate(name)
        if (!dir) return null
        try {
            const raw = readFileSync(join(dir, "package.json"), "utf8")
            const parsed = JSON.parse(raw) as { version?: string }
            return parsed.version ?? null
        } catch {
            // Present but unreadable is not installed. A half-extracted or
            // corrupt package must reinstall rather than be trusted.
            return null
        }
    }

    return {
        resolves: resolves,
        locate: locate,
        installedVersion: installedVersion,

        /**
         * True when the framework packages are materialized in a node_modules
         * tree the project can see — its own, or a parent workspace's. A fresh
         * scaffold declares the deps in package.json but has no node_modules
         * yet, so "declared" is not "installed": prepare must install whenever
         * this is false.
         *
         * `existsSync` FOLLOWS symlinks, which is what makes this correct for a
         * grafted project: every entry is a link into the shared tree cache, so
         * a tree that was evicted out from under it reads as not-installed and
         * triggers the reinstall that fixes it. A link-existence check (lstat)
         * would see the dangling link, call it installed, and leave the agent
         * permanently broken.
         */
        frameworkInstalled(): boolean {
            if (!resolves("@arcforge/types")) return false

            // Resolving is not enough when a SOURCE checkout is in play: a
            // grafted cache tree resolves perfectly well and is the published
            // framework, so treating it as installed skipped the relink and
            // left every agent testing against whatever was last released —
            // no matter what the developer had edited. Asking whether the
            // link already points at the checkout makes "installed" mean the
            // right framework, not merely a present one.
            const workspace = workspaceSource()
            if (!workspace) return true

            return FRAMEWORK_PACKAGES.every(name => {
                const source = frameworkDir(workspace, name)
                if (!source) return true // not in this checkout — published is correct
                const target = join(root, "node_modules", ...name.split("/"))
                try {
                    return realpathSync(target) === source
                } catch {
                    return false
                }
            })
        },

        /**
         * True when node_modules exists but its entries point nowhere — a
         * graft onto a shared cache tree that has since been evicted.
         */
        graftBroken(): boolean {
            return graftBroken(root)
        },

        /**
         * Is the installed tree coherent with what the project declares?
         *
         * THE ONE GATE. Every dependency question the pipeline asks resolves
         * here, so a new class of breakage becomes a new `Fault` variant
         * instead of another bespoke repair bolted to the front of prepare —
         * which is how four separate repairs accumulated before this existed.
         *
         * Pure inspection: it reports faults and repairs nothing, because
         * `--frozen` must be able to ask this exact question and refuse. A
         * check that fixes what it finds can never fail.
         */
        async verify(input: {
            manifest: ManifestT
            managed: Record<string, string>
            registryOrigin: string
        }): Promise<VerifyReport> {
            return verify({
                root,
                manifest: input.manifest,
                managed: input.managed,
                registryOrigin: input.registryOrigin,
                installedVersion: installedVersion,
                locate: locate,
            })
        },

        /** True when every name is resolvable from this project. */
        allResolve(names: string[]): boolean {
            return names.every(resolves)
        },

        /**
         * Delete the project's node_modules.
         *
         * For the broken-graft case specifically: installing over a directory
         * of dangling links leaves them in place (bun writes what it resolves
         * and does not audit what it did not touch), so the tree has to go
         * before the reinstall rather than after.
         */
        async clearModules(): Promise<void> {
            await rm(join(root, "node_modules"), { recursive: true, force: true })
        },

        /**
         * Delete the lockfile.
         *
         * For a registry switch specifically. A lockfile is a pin, and
         * replaying one is normally exactly right — but bun.lock pins
         * fully-qualified TARBALL URLs, so a lock written against another
         * registry re-fetches every package from there regardless of what
         * bunfig now maps. Discarding it is what makes the next install
         * resolve against the registry actually in play.
         */
        async clearLock(): Promise<void> {
            await rm(join(root, "bun.lock"), { force: true })
        },

        /**
         * Materialize node_modules from package.json, via Bun.
         *
         * Resolves in an ISOLATED copy of the manifest rather than in place:
         * agents often live inside a monorepo, and running `bun install` there
         * makes Bun walk up to the workspace root, where a checked-in source
         * package can shadow the published module of the same name. Installing
         * a copy and then materializing its node_modules keeps the agent
         * self-contained and makes local dev match a fresh clone.
         */
        async install(opts?: {
            refresh?: string[]
            /**
             * Called before each wait while a just-published version reaches
             * this npm edge. Optional — a caller with no surface passes
             * nothing, and a multi-second pause simply happens quietly.
             */
            onPropagationRetry?: (delayMs: number, attempt: number) => void
        }): Promise<void> {
            // A refresh deliberately re-resolves within declared ranges, so
            // its result depends on what the registry holds right now rather
            // than on what the project declares. Nothing else is excluded: an
            // existing lockfile is a pin, and treeKey() hashes it, so a hit
            // means the ranges AND the pins matched.
            const cacheable = !opts?.refresh?.length

            const staging = await mkdtemp(join(tmpdir(), "axon-agent-deps-"))
            try {
                // `workspace:*` and `file:` are both "local", and they need
                // OPPOSITE treatment in the isolated install:
                //
                //   workspace:*  cannot resolve here — there is no workspace in
                //                the staging dir, by design. Stripped, then
                //                symlinked back afterwards, so a deliberate link
                //                to a local checkout (how the framework is
                //                developed against a real agent) survives rather
                //                than being rewritten to the published version.
                //
                //   file:        resolves fine, and MUST be kept: a source
                //                module's own dependencies are declared in ITS
                //                package.json, so stripping the file: entry means
                //                Bun never sees them and they are never fetched.
                //                The module then symlinks in with an empty dep
                //                tree and fails at import. Only the path needs
                //                fixing — it is relative to the agent root, and
                //                staging is somewhere else entirely.
                const declared = JSON.parse(await Bun.file(join(root, "package.json")).text()) as {
                    dependencies?: Record<string, string>
                    overrides?: Record<string, string>
                }
                const entries = Object.entries(declared.dependencies ?? {})
                const workspace = entries.filter(([, range]) => range.startsWith("workspace:"))

                // `overrides` carries the SAME rewrite as dependencies: it
                // exists to redirect a linked package's own `workspace:*`
                // deps at the local tree, and those paths are relative to the
                // agent root just like the dependency entries. Left
                // unrewritten (or dropped by the spread) the staging install
                // fails with "Workspace dependency not found" on a package
                // the agent never declared.
                const isolated = {
                    ...declared,
                    ...(declared.overrides ? { overrides: rebase(declared.overrides, root) } : {}),
                    dependencies: Object.fromEntries(
                        entries
                            .filter(([name]) => !workspace.some(([wsName]) => wsName === name))
                            .map(([name, range]): [string, string] => range.startsWith("file:")
                                ? [name, `file:${resolve(root, range.slice("file:".length)).split(/[\\/]/).join("/")}`]
                                : [name, range]),
                    ),
                }
                await Bun.write(join(staging, "package.json"), JSON.stringify(isolated, null, 2))

                // The agent's bunfig.toml carries the @axon scope → registry
                // mapping. Without it the isolated install cannot resolve a
                // single Axon module.
                const bunfig = join(root, "bunfig.toml")
                if (existsSync(bunfig)) await cp(bunfig, join(staging, "bunfig.toml"))

                // The isolated install is a pure function of what was just
                // written into staging: the rebased manifest, the registry
                // mapping, and the lockfile pin. Identical inputs therefore
                // produce an identical tree, and that is worth caching —
                // scaffolding N projects from one template (every fixture in
                // the test suite, every `axon init` on a warm machine) re-ran
                // the same resolution and then physically copied the same
                // ~36MB/1400 files each time.
                //
                // Keyed by content rather than by project, so nothing has to
                // decide when it went stale: a changed dependency is a
                // different key, and the old entry is simply never read again.
                const key = cacheable ? await cache.key(staging) : null
                if (key) {
                    const hit = cache.entry(key)
                    if (existsSync(join(hit, "node_modules"))) {
                        await cache.touch(hit) // a hit is a use — eviction sorts on this, not on write time
                        await graft(join(hit, "node_modules"), join(root, "node_modules"))
                        // Recorded AFTER the graft, so the tree is only claimed
                        // once this project genuinely points into it.
                        await cache.addReferrer(hit, resolve(root))
                        if (existsSync(join(hit, "bun.lock"))) await cp(join(hit, "bun.lock"), join(root, "bun.lock"))
                        await linkLocal(root, workspace)
                        await linkFramework(root)
                        return
                    }
                }

                // Replay the existing lockfile so an install that changes
                // nothing re-resolves nothing — same versions as the last run.
                const lock = join(root, "bun.lock")
                if (existsSync(lock)) await cp(lock, join(staging, "bun.lock"))

                let result = await Bun.$`bun install --cwd ${staging}`.quiet().nothrow()

                // Then force the named packages to re-resolve inside their
                // declared ranges. The lockfile is a pin, correctly: replaying
                // it is what makes an unchanged install reproducible. But a
                // pin also means a published fix can never reach an agent that
                // already holds the broken version — `^0.1.0` permits 0.1.1
                // and the lock says 0.1.0, so nothing moves and the author's
                // fix is invisible forever. `bun update <name>` is the one
                // thing that re-resolves within a range, and it runs ONLY for
                // packages reconcile found outside theirs.
                if (result.exitCode === 0 && opts?.refresh?.length) {
                    const refreshed = await Bun.$`bun update --cwd ${staging} ${opts.refresh}`.quiet().nothrow()
                    // A refresh failure is not fatal: the tree from the
                    // install above is still valid, just older than it could
                    // be. Reconcile will report it again next run.
                    if (refreshed.exitCode === 0) result = refreshed
                }

                // Propagation lag: the version we pinned exists but has not
                // reached this npm edge yet. The CLI pins framework versions
                // matching ITSELF, so the very first `axon init` after an
                // `axon update` asks for exactly the versions just published —
                // which is why this fires seconds after an update succeeded.
                //
                // `--no-cache` alone was the previous answer, retried ONCE and
                // immediately. It bypasses Bun's manifest cache but cannot make
                // an edge serve what it has not received, so the retry consumed
                // the race rather than waiting it out. `axon update` had the
                // right policy all along (four attempts, backoff); this now
                // shares it. See project/propagation.ts.
                if (result.exitCode !== 0 && isPropagationLag(combinedOutput(result))) {
                    const retried = await withPropagationRetry(
                        async () => {
                            const attempt = await Bun.$`bun install --cwd ${staging} --no-cache`.quiet().nothrow()
                            result = attempt
                            return { ok: attempt.exitCode === 0, output: combinedOutput(attempt) }
                        },
                        { ...(opts?.onPropagationRetry ? { onRetry: opts.onPropagationRetry } : {}) },
                    )
                    void retried
                }

                // A `file:` dependency is materialized through bun's shared
                // link cache, so two installs linking the SAME package at the
                // same moment race and one loses with EEXIST. That is the
                // normal case under a parallel test run, where several
                // fixtures link this repo's framework at once. `copyfile`
                // copies instead of linking, so concurrent installs never
                // touch the same cache entry.
                if (result.exitCode !== 0 && isConcurrentLinkRace(combinedOutput(result))) {
                    result = await Bun.$`bun install --cwd ${staging} --backend=copyfile`.quiet().nothrow()
                }

                if (result.exitCode !== 0) {
                    const detail = result.stderr.toString().trim()
                        || result.stdout.toString().trim()
                        || `exit ${result.exitCode}`
                    throw err("MODULE_DEPENDENCY_INSTALL_FAILED", { detail })
                }

                // Publish before materializing: the tree in staging is the
                // clean one. The project's copy gets local symlinks grafted
                // into it by linkLocal() below, and those point at THIS
                // project's checkout — caching them would hand another project
                // a tree with someone else's paths baked in.
                if (key) await cache.publish(key, staging)

                await materialize(join(staging, "node_modules"), join(root, "node_modules"))
                // Only workspace deps are relinked. A file: dep was part of the
                // real install, so its directory in node_modules is the tree Bun
                // built — replacing it with a bare symlink would discard exactly
                // the transitive dependencies this install went and fetched.
                await linkLocal(root, workspace)
                await linkFramework(root)
                if (existsSync(join(staging, "bun.lock"))) {
                    await cp(join(staging, "bun.lock"), join(root, "bun.lock"))
                }
            } finally {
                await rm(staging, { recursive: true, force: true })
            }
        },

        materialize: materialize,
    }
}

export type TreeT = ReturnType<typeof Tree>

/**
 * Copy an isolated Bun install into its permanent location.
 *
 * Links are preserved, then the ones that would dangle are repaired.
 *
 * The distinction matters because bun's isolated linker keeps exactly one real
 * copy of each package under `node_modules/.bun/` and makes every other
 * appearance a RELATIVE link into it. Those stay valid when the tree moves, so
 * copying them verbatim is both correct and much cheaper: dereferencing turned
 * 1,115 files into 3,917 (the same packages, materialized once per referrer)
 * and took 3.4x as long.
 *
 * What genuinely cannot survive is an ABSOLUTE link — bun emits those in
 * `.bin`, pointing back into the staging directory that is deleted moments
 * later, which would make every package executable vanish. Those are resolved
 * here, while the source still exists. Fixing exactly them keeps the guarantee
 * the old blanket dereference was reaching for (a self-contained tree) without
 * paying for it across the whole install.
 */
async function materialize(source: string, target: string): Promise<void> {
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true, verbatimSymlinks: true })
    await resolveAbsoluteLinks(target)
}

/**
 * Point a project's node_modules at a cached tree, without copying it.
 *
 * One symlink per top-level entry rather than a recursive copy: the cached
 * tree is immutable and shared, so 925 files do not need to exist once per
 * project. This is the difference between ~370ms and ~1ms per install, which
 * is what makes scaffolding cheap enough to do in a test fixture.
 *
 * The top level is a REAL directory holding links, never a link to the cached
 * directory itself. That is what keeps the shared tree safe: linkLocal() and
 * any later install replace entries HERE — unlinking this project's pointer —
 * and a project that adds a dependency gets its own real tree from the install
 * path below. Nothing writes through into the cache.
 *
 * Absolute links inside the cached tree would still be a hazard, since they
 * escape it entirely; publishTree() resolves them before an entry is stored,
 * so by this point there are none.
 */
async function graft(source: string, target: string): Promise<void> {
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })

    for (const entry of await readdir(source)) {
        await symlink(join(source, entry), join(target, entry))
    }
}

async function linkLocal(root: string, local: Array<[string, string]>): Promise<void> {
    for (const [name, range] of local) {
        const source = range.startsWith("file:")
            ? resolve(root, range.slice("file:".length))
            : findWorkspacePackage(root, name)
        if (!source) continue

        const target = join(root, "node_modules", ...name.split("/"))
        await rm(target, { recursive: true, force: true })
        await mkdir(dirname(target), { recursive: true })
        await symlink(source, target, "dir")
    }
}

/** Re-anchor `file:` ranges from the agent root to absolute paths the staging install can resolve. */
function rebase(ranges: Record<string, string>, root: string): Record<string, string> {
    return Object.fromEntries(
        Object.entries(ranges).map(([name, range]): [string, string] => range.startsWith("file:")
            ? [name, `file:${resolve(root, range.slice("file:".length)).split(/[\\/]/).join("/")}`]
            : [name, range]),
    )
}

/**
 * The framework packages an agent resolves at runtime.
 *
 * These are the ones a compiled cognet fuses to or imports by bare specifier,
 * so a stale copy in an agent's tree is a stale RUNTIME — not merely an old
 * type. `@arcforge/cognet` is the sharp case: its `host.ts` hand-writes the
 * ambient `kernel` facade, so an agent holding a published copy from before an
 * ABI change gets a shim missing the new verb and fails with a bare TypeError
 * naming a syscall that does exist.
 */
const FRAMEWORK_PACKAGES = [
    "@arcforge/types",
    "@arcforge/err",
    "@arcforge/engines",
    "@arcforge/air",
    "@arcforge/session",
    "@arcforge/cognet",
] as const

/**
 * The workspace checkout a source build should link its framework from.
 *
 * Set by the source-run entrypoint (`apps/tui/bin/axon`, what `axonl` runs);
 * absent for an installed CLI, which must always use published packages. That
 * asymmetry is the whole point: an agent lives outside the repo (under
 * `~/.axon-dev/profiles/...`), so the ordinary workspace walk finds nothing
 * and every agent silently installs whatever the registry last published.
 *
 * Without this, the only way to exercise a framework change against a real
 * agent is a full release — which makes the publish step part of the inner
 * dev loop, and means a broken ABI is discovered by users rather than by the
 * person who changed it.
 */
function workspaceSource(): string | null {
    const root = process.env.AXON_WORKSPACE
    if (!root) return null
    return existsSync(join(root, "package.json")) ? resolve(root) : null
}

/**
 * Framework packages, linked from the source checkout rather than installed.
 *
 * Runs only when AXON_WORKSPACE is set, and only for packages that genuinely
 * exist there — an unknown name is skipped rather than removed, so a partial
 * checkout degrades to the published copy instead of an unresolvable import.
 */
async function linkFramework(root: string): Promise<void> {
    const workspace = workspaceSource()
    if (!workspace) return

    for (const name of FRAMEWORK_PACKAGES) {
        const source = frameworkDir(workspace, name)
        if (!source) continue

        const target = join(root, "node_modules", ...name.split("/"))
        // Already pointing at this source — leave it, so a reload does not
        // churn the tree the bundler may be reading.
        if (existsSync(target) && realpathSync(target) === source) continue

        await rm(target, { recursive: true, force: true })
        await mkdir(dirname(target), { recursive: true })
        await symlink(source, target, "dir")
    }
}

/**
 * Where a framework package lives inside the checkout.
 *
 * A DIRECT search rather than findWorkspacePackage(), which caps its scan at
 * `-maxdepth 4` and so cannot see a manifest at `libs/axon/packages/<pkg>` (depth
 * 5). That limit is fine for the workspace walk it was written for; silently
 * inheriting it here would link two packages and skip four, which is worse
 * than linking none — a tree half on source and half on published is a
 * version skew nobody would think to look for.
 *
 * Verified by NAME, never by path convention: the manifest has to actually
 * claim the specifier, so a moved or renamed package fails to link instead of
 * linking the wrong directory.
 */
/**
 * Every package.json under `root`, to `depth` levels, skipping node_modules.
 *
 * Walked in-process rather than shelled out to `find`. Two reasons, and the
 * second is the one that matters:
 *
 * - `find` does not exist on Windows, so the spawn produced no output there.
 * - `spawnSync` reports a missing binary as EMPTY STDOUT, which is exactly what
 *   a successful search with no matches looks like. Both call sites then looped
 *   over nothing and returned null — so "this machine has no `find`" was
 *   indistinguishable from "this workspace has no framework packages", and a
 *   developer on a Mac or Windows box silently linked against the published
 *   copy while believing they were testing their own checkout.
 *
 * A directory walk cannot fail that way: an unreadable directory is skipped
 * explicitly, and there is no binary to be absent.
 */
function manifestsUnder(root: string, depth: number): string[] {
    const out: string[] = []

    const walk = (dir: string, remaining: number): void => {
        if (remaining < 0) return
        let entries
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            // Unreadable directory — a permission fault or a broken symlink.
            // Skipped rather than fatal: it is one branch of a search, and the
            // caller's question is "is this package here", not "is every
            // directory readable".
            return
        }
        for (const entry of entries) {
            if (entry.name === "node_modules") continue
            const path = join(dir, entry.name)
            if (entry.isDirectory()) walk(path, remaining - 1)
            else if (entry.name === "package.json") out.push(path)
        }
    }

    walk(root, depth)
    return out
}

function frameworkDir(workspace: string, name: string): string | null {
    const found = manifestsUnder(join(workspace, "libs"), 5)

    for (const candidate of found) {
        if (!candidate) continue
        try {
            const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }
            if (pkg.name === name) return dirname(candidate)
        } catch { /* unreadable manifest is not a match */ }
    }
    return null
}

/** Walk up looking for a workspace member with this package name. */
function findWorkspacePackage(from: string, name: string): string | null {
    let dir = resolve(from)
    while (true) {
        const manifest = join(dir, "package.json")
        if (existsSync(manifest)) {
            try {
                const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: string[] }
                if (pkg.workspaces) {
                    const found = manifestsUnder(dir, 4)
                    for (const candidate of found) {
                        if (!candidate) continue
                        try {
                            const c = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }
                            if (c.name === name) return dirname(candidate)
                        } catch { /* unreadable manifest is not a match */ }
                    }
                }
            } catch { /* unreadable manifest — keep walking */ }
        }
        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

/** Everything a bun subprocess said, for classifying its failure. */
function combinedOutput(result: { stderr: Buffer; stdout: Buffer }): string {
    return result.stderr.toString() + result.stdout.toString()
}

/** Two installs linking the same `file:` package into bun's shared cache at once. */
function isConcurrentLinkRace(output: string): boolean {
    return /EEXIST.*failed to link package/.test(output)
}

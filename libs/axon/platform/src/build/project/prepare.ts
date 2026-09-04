import type { FrameworkSource } from "./manifest/package"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { ProviderEntry } from "@arcforge/types"
import { resolveDefaultBaseUrl } from "@arcforge/cloud"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { Blueprint, Config, cognetAbi, cognetName, cognetSourceOf, readCognetModels, flatten, DEFAULT_COGNET, type CognetSource, type ScanWarning } from "../blueprint"
import { reconcile } from "./reconcile"
import { describeFaults } from "./verify"
import { Models } from "./models"

import type { InstallerT, InstallResult } from "./installer"
import type { ManifestT } from "./manifest"
import type { TreeT } from "./tree"
import type { LinkResult, SourceModulesT } from "./modules"
import type { TypegenResult, TypegenT } from "./typegen"
import { fsx } from "../../utils/fs"
import { migrateFrame } from "../frame"
import { migrateEngineField } from "./manifest/engine-migrate"
import { KINDS, type ProjectKind } from "./kinds"

export type PrepareResult = {
    modules: InstallResult[]
    sourceModules: LinkResult[]
    typegen: TypegenResult
    warnings: ScanWarning[]
}

type PrepareOpts = {
    root: string
    kind: ProjectKind
    installer: InstallerT
    manifest: ManifestT
    modules: SourceModulesT
    tree: TreeT
    typegen: TypegenT
    /** CLI version — the framework deps prepare declares/repairs are pinned to it. */
    frameworkVersion: string
    /** Where framework deps resolve from — "workspace" links this repo's tree (tests). */
    frameworkSource?: FrameworkSource
    /** Repo root, required when frameworkSource is "workspace". */
    repoRoot?: string
    /**
     * Kind-specific work that runs after the shared frame is written. Benches
     * use it to generate declarations from their own config; nothing else has
     * needed it yet.
     */
    extend?: () => Promise<void>
    /**
     * Where this prepare reports its phases.
     *
     * A plain callback rather than a session handle: prepare is the stage
     * that RUNS before a runtime exists, so it must not know what a session
     * is. The caller that has one (Agent(), via BuildRecorder) supplies a
     * sink that writes there; a caller that does not — `axon prepare` on
     * its own — passes nothing and the spans cost nothing.
     */
    report?: BuildReporter
    /**
     * The active profile's declared inference sources.
     *
     * Read at load and carried onto the blueprint, never baked into the
     * project: a blueprint travels (it is what `axon deploy` ships) and a
     * deployed agent has no profile at all, so a user's local Ollama daemon
     * must not become an artifact's dependency.
     */
    profileProviders?: () => Promise<readonly ProviderEntry[] | undefined>
}

/**
 * Runs one build span, or just the work when nobody is listening.
 *
 * Mirrors @arcforge/session's `span()` deliberately rather than importing
 * it: this package must not depend on the session package to be
 * instrumented, and the contract here is two lines. The `finally`-shaped
 * guarantee is the point — a span opened is always closed, with the error
 * attached, because a flame graph with an unclosed bracket shows a phantom
 * bar running to the end of the log.
 */
async function phase<T>(
    report: BuildReporter | undefined,
    name: "build:framework" | "build:modules" | "build:cognet" | "build:tree" | "build:typegen",
    start: Record<string, unknown>,
    run: () => Promise<T>,
    complete?: (value: T) => Record<string, unknown>,
): Promise<T> {
    if (!report) return run()

    const began = Date.now()
    report(`${name}:start`, start)
    try {
        const value = await run()
        report(`${name}:complete`, { ...start, ...(complete ? complete(value) : {}), durationMs: Date.now() - began })
        return value
    } catch (cause) {
        report(`${name}:failed`, { ...start, error: cause, durationMs: Date.now() - began })
        throw cause
    }
}

/**
 * Where a build phase reports itself. See PrepareOpts.report.
 *
 * `unknown` payloads rather than the typed BuildEventMap: that map lives in
 * @arcforge/types alongside the session, and prepare stays free of both.
 * The caller supplying the sink is the one that knows the event shapes.
 */
export type BuildReporter = (type: string, data: unknown) => void

/**
 * Prepare — the sequence that makes a project bootable. One sentence:
 * install what's declared, compile the brain, then generate types from
 * what's there.
 *
 * Agents: read declared modules (Config throws on a broken config — no
 * agent), install registry specifiers, load the blueprint AFTER install so
 * fresh modules are scanned, typegen from its surfaces.
 *
 * Modules: the static typegen frame only.
 *
 * Per-module install failures and scan warnings are returned, not thrown —
 * the caller decides severity.
 */
export function Prepare(opts: PrepareOpts) {
    const { root, kind, installer, manifest, modules, tree, typegen, frameworkVersion, frameworkSource, repoRoot, extend } = opts

    const blueprint = Blueprint({ root: root })
    // Named `weights` locally: `modules` is already the source-module
    // manager here, and two different things called models/modules in one
    // function is exactly the kind of near-collision that reads fine and
    // debugs badly.
    const weights = Models()

    /**
     * True when everything the installed cognet needs to compile is
     * materialized in a node_modules tree the agent can see.
     *
     * The cognet is compiled by bundling its import graph out of the AGENT's
     * tree, so what it imports must be present THERE — not merely declared by
     * it. A cognet that gained a requirement between versions is the case this
     * catches: the agent's own manifest is unchanged, so nothing else would
     * trigger an install, and the failure would otherwise surface as an
     * unresolvable import inside the bundler.
     *
     * PEER dependencies are checked alongside regular ones, and are the reason
     * this still has a job. `@arcforge/cognet` is a peer of every cognet — the
     * host provides exactly one copy, which is what stops Bun from nesting a
     * second runtime — and Bun does not install a peer it cannot already
     * satisfy. So a peer is precisely the kind of requirement that can be
     * declared and absent, which is the condition the bundler cannot recover
     * from.
     *
     * Absent cognet, unreadable manifest, or nothing declared → true (nothing
     * to install); the resolve step that follows reports a missing cognet
     * properly.
     */
    async function cognetDependenciesPresent(source: CognetSource): Promise<boolean> {
        let sourceDir: string
        try {
            sourceDir = blueprint.cognet.sourceDir(source)
        } catch {
            return true // not installed yet — the install above is what fixes that
        }

        const cognetManifest = await fsx.readJson<{
            dependencies?: Record<string, string>
            peerDependencies?: Record<string, string>
        }>(join(sourceDir, "package.json"))

        return tree.allResolve([
            ...Object.keys(cognetManifest?.dependencies ?? {}),
            ...Object.keys(cognetManifest?.peerDependencies ?? {}),
        ])
    }

    /**
     * The cognet's own non-framework dependencies, at the ranges IT declares.
     *
     * These become the agent's, because the compiled bundle runs from the
     * agent and imports them by bare specifier. `@arcforge/*` is excluded:
     * the host must be the one copy the agent already has, and a second
     * nested runtime would give the brain a different ambient scope than the
     * kernel bound.
     *
     * Ranges are copied rather than re-pinned, so the cognet author's own
     * constraint is what governs — the agent is carrying a dependency on
     * behalf of a brain it did not write.
     */
    async function cognetDependencyRanges(source: CognetSource): Promise<Record<string, string>> {
        let sourceDir: string
        try {
            sourceDir = blueprint.cognet.sourceDir(source)
        } catch {
            return {} // not installed yet; the install below is what fixes that
        }

        const pkg = await fsx.readJson<{ dependencies?: Record<string, string> }>(
            join(sourceDir, "package.json"),
        )

        return Object.fromEntries(
            Object.entries(pkg?.dependencies ?? {}).filter(([name]) => !name.startsWith("@arcforge/")),
        )
    }

    /**
     * Installed packages that are cognets but are NOT the one now selected.
     *
     * A cognet is the only dependency an agent acquires without declaring it
     * in `modules: [...]`, so nothing else would ever clean one up — switching
     * `cognet:` used to leave the previous brain in package.json forever.
     *
     * Identified by PROOF, not by name: a package is a cognet when the thing
     * installed at that name carries a cognet.config.ts. Guessing from a
     * scope or a naming convention would eventually delete a user's own
     * dependency, which is far worse than leaving a stale one behind.
     */
    async function cognetDependencies(
        declared: Record<string, string>,
        selected: string | null,
    ): Promise<Set<string>> {
        const found = new Set<string>()
        for (const name of Object.keys(declared)) {
            if (name === selected) continue
            const dir = tree.locate(name)
            if (dir && fsx.exists(join(dir, "cognet.config.ts"))) found.add(name)
        }
        return found
    }

    /**
     * @param options.frozen Assert that the manifest and the installed tree
     * already agree, instead of making them agree. Throws on any drift and
     * never writes.
     *
     * The reproducible counterpart to prepare's normal reconciling behaviour,
     * for CI and deploy — where "the build quietly upgraded something" is a
     * worse outcome than "the build failed and told you what moved".
     */
    return async function prepare(options: { frozen?: boolean; report?: BuildReporter } = {}): Promise<PrepareResult> {
        // Per call, not per construction: the project is opened long before
        // anything knows where its build should report. Agent() supplies a
        // session-backed sink at boot; `axon prepare` on its own supplies
        // nothing and every span below is a no-op.
        const report = options.report ?? opts.report

        /**
         * A just-published version has not reached this npm edge yet.
         *
         * Reported as a build event rather than swallowed: the wait is real
         * seconds, and a caller watching a step list needs to see WHY it is
         * still going. Without it a legitimate backoff reads as a hang against
         * a registry doing exactly what it should.
         */
        const notePropagation = (delayMs: number, attempt: number): void => {
            report?.("build:warning", {
                domain: "install",
                error: `a just-published version has not reached this npm edge yet — retrying in ${delayMs / 1_000}s (attempt ${attempt})`,
            })
        }

        // Convert a pre-grouping frame before anything reads or writes one.
        //
        // FIRST, ahead of even the prompt early-return below, because every
        // kind has a frame and every kind's is affected. It discards the
        // regenerable files (types, caches, build output) that the rest of
        // this function is about to rewrite anyway, and physically moves the
        // runtime output that nothing can rebuild. Idempotent — on an
        // already-current project it stats a few paths and returns.
        const migration = await migrateFrame(root, kind)
        if (migration.migrated) {
            report?.("build:frame:migrated", {
                root: root,
                kind: kind,
                discarded: migration.discarded,
                dataMoved: migration.dataMoved,
            })
        }

        // Beside the frame migration and for the same reason: an agent already
        // on disk carries a field the runtime now REFUSES, and the user did not
        // put it there — zeno ships to everyone and most people never wrote its
        // config. Removing it here means the repair happens on the next launch
        // with nobody typing anything.
        //
        // Ahead of every read of the config below, which is the whole ordering
        // requirement: `engine:` is fatal at load, so a migration running after
        // the load would never get the chance.
        if (kind === "agent") {
            const engine = await migrateEngineField(root)
            if (engine.migrated) {
                report?.("build:config:migrated", {
                    root: root,
                    field: "engine",
                    ...(engine.model ? { model: engine.model } : {}),
                })
            }
        }

        // A prompt package is text: it declares no dependencies, so there is
        // nothing to install and its frame is self-contained. It still gets
        // one — definePrompt() is a global, and prompt.config.ts calls it.
        //
        // This returns BEFORE framework.ensure(): declaring @arcforge/types in
        // a package that never installs would put a dependency in package.json
        // that is guaranteed absent from disk, and package.json is published
        // verbatim, so every consumer would inherit the phantom.
        if (!KINDS[kind].installs) {
            return { modules: [], sourceModules: [], typegen: await typegen.write(), warnings: [] }
        }

        // Ensure @arcforge/types + @arcforge/engines + h3 are declared and on
        // disk before typegen runs — its generated tsconfig `extends`
        // @arcforge/types/tsconfig.base.json and the .d.ts references those
        // packages. This also self-heals older agents that declared none of
        // them (their types used to come from machine-local tsconfig paths).
        const frameworkChanged = await phase(
            report,
            "build:framework",
            { version: frameworkVersion },
            () => manifest.package.framework.ensure(frameworkVersion, frameworkSource, repoRoot, KINDS[kind].framework),
            changed => ({ version: frameworkVersion, changed }),
        )

        // "Declared" is not "installed": a fresh scaffold writes the deps into
        // package.json but has no node_modules, so frameworkChanged is false
        // (nothing to add) yet an install is still required. Key off actual
        // resolvability, not just a manifest edit.
        // ── The pre-install gate ──────────────────────────────────────────
        //
        // Verification runs BEFORE the installs, and that ordering is the
        // whole point of this block. It used to run last (see `reconcile`
        // below), which meant every install that could fail ran first — so
        // each new breakage got its own repair bolted to the front of this
        // function, one incident at a time.
        //
        // Only manifest-level faults can be judged this early: `managed` is
        // not known until the installers have declared their ranges. That is
        // exactly enough, because these are the faults that kill `bun install`
        // itself. Bun resolves the WHOLE manifest at once, so one unresolvable
        // range fails every other package with it — a poisoned cognet range
        // killed the modules install long before the cognet step that would
        // have re-resolved it.
        const repairedRanges = await installer.repairForeignRanges()

        // The registry bunfig.toml FETCHES from, corrected here for the same
        // reason ranges are: bun reads this file, not our env, so a stale
        // mapping fails the install before anything downstream can repair it.
        //
        // This ran only AFTER the installs at first, which made it useless in
        // exactly the case it exists for — an agent whose ranges came from
        // production while bunfig pointed at local staging failed on every
        // package at once, and the repair sat two hundred lines past the
        // throw. A repair that runs after the thing it repairs is not a repair.
        //
        // The lockfile goes with it: bun.lock pins fully-qualified tarball
        // URLs, so replaying one written against the other registry re-fetches
        // everything from there regardless of what bunfig now says.
        const registryOrigin = resolveDefaultBaseUrl()
        const staleScopes = Object.entries(await manifest.bunfig.scopes())
            .filter(([, mapped]) => !mapped.startsWith(registryOrigin))
        if (staleScopes.length > 0) {
            for (const [scope] of staleScopes) {
                await manifest.bunfig.ensure(scope, `${registryOrigin}/api/registry/npm/-`)
            }
            await tree.clearLock()
            await tree.clearModules()
        }

        // A node_modules of dangling symlinks is a real, recoverable state:
        // the project was grafted onto a shared cache tree that has since been
        // evicted. The stale directory must be REMOVED rather than installed
        // over — bun writes what it resolves and does not audit what it did
        // not touch, so the dangling links would survive the reinstall.
        if (tree.graftBroken()) await tree.clearModules()

        const needsFrameworkInstall = frameworkChanged || !tree.frameworkInstalled()

        // Every installing kind installs its dependencies and writes its
        // frame. Only an agent goes further: it resolves modules, compiles a
        // cognet, and loads a blueprint, because only an agent has those.
        if (kind !== "agent") {
            if (needsFrameworkInstall) await tree.install({ onPropagationRetry: notePropagation })
            const written = await typegen.write()
            // Kinds whose declarations come from their own config generate
            // them here, on top of the shared frame — a bench's axes and
            // measurement schema are the only case today.
            await extend?.()
            return { modules: [], sourceModules: [], typegen: written, warnings: [] }
        }

        const config = await Config(root)
        const entries = await flatten(config.modules, config.modulePaths)

        // Hard-imported (source) modules become `file:` dependencies, so Bun
        // links them and resolves their deps exactly as it does a registry
        // package — origin must never change how a module's deps resolve.
        // Their content hash stands in for a semver they don't have.
        const declaredSources = []
        for (const entry of entries) {
            if (entry.kind !== "source") continue
            declaredSources.push(await modules.resolve(entry.configPath))
        }

        // Prune BEFORE installing: a module that moved from a source import
        // to a registry install still holds its `file:` dependency, and Bun
        // would keep linking the local copy over whatever the registry
        // serves. Removing it first frees the name.
        const pruned = await modules.prune(declaredSources)

        const specifiers = entries.filter(e => e.kind === "registry").map(e => e.name)
        const installed = await phase(
            report,
            "build:modules",
            { specifiers },
            () => installer.install(specifiers),
            results => ({
                specifiers,
                installed: results.filter(r => r.status === "installed").map(r => r.name),
                alreadyPresent: results.filter(r => r.status !== "installed").map(r => r.name),
            }),
        )

        // The cognet is a registry artifact installed like any other package,
        // but it is NOT a module: it is selected by `cognet:`, so it must not
        // be written into the config's modules array.
        // Choosing nothing is not the same as choosing the default. An agent
        // that never named a cognet tracks the registry's latest zero, so the
        // brain nobody selected keeps up to date on its own; an agent that
        // named one — with or without a version — keeps what it asked for.
        //
        // This also makes an unresolvable range unable to survive: dave's
        // package.json acquired "@axon/zero": "^2.0.100" from a workspace
        // sibling whose version is a framework version, and because the
        // installer honoured a declared range as a deliberate pin, every
        // prepare re-asserted a version that exists nowhere but this machine.
        // `abi` is what makes "latest" safe to track. A cognet bundle is fused
        // to one kernel contract, so the newest published version is not
        // automatically one this runtime can load — asking the registry for the
        // newest version targeting THIS kernel means an incompatible bundle is
        // never installed, instead of being installed and then rejected by
        // cognetAbi() after the fact.
        //
        // A SOURCE cognet skips all of this. It is a directory on disk — one
        // the author pointed at with an import, or wrote inline at `cognet/` —
        // not a package to fetch, so there is no registry lookup, no version to
        // resolve, and no ABI negotiation: the source is whatever they have
        // checked out. The ABI is still verified below, from the same
        // cognet.config.ts every origin ends at.
        const cognetSource = cognetSourceOf(config) ?? { kind: "registry" as const, specifier: DEFAULT_COGNET }

        // Whether the agent CHOSE its brain, which an inline cognet/ does just
        // as much as a `cognet:` line — the folder is the declaration. Only an
        // agent that chose nothing tracks the registry's latest, and this flag
        // is read solely on the registry path, where an inline cognet never
        // arrives.
        const declaredCognet = config.value.cognet !== undefined || cognetSource.kind === "source"

        const cognetInstall = cognetSource.kind === "source"
            ? []
            : await installer.install([cognetSource.specifier], {
                declare: false,
                abi: KERNEL_ABI_VERSION,
                ...(declaredCognet ? {} : { track: "latest" as const }),
            })

        const cognetSpecifier = cognetSource.kind === "source" ? cognetSource.dir : cognetSource.specifier
        const cognetFailure = cognetInstall.find(result => result.status === "not-found" || result.status === "error")
        if (cognetFailure) {
            // "Published, but nothing built for this kernel" is a DIFFERENT
            // failure from "no such cognet", and the registry answers 409 to
            // say so — with the ABIs it does have. Reporting it as
            // COGNET_NOT_FOUND would tell the user to check their spelling
            // when the real answer is to update Axon or pin an older version.
            // Matched on the registry's own phrasing for the ABI case, and
            // ONLY that phrasing. A 404 for a range that matched nothing also
            // mentions the ABI ("...satisfies ^0.1.0 for kernel ABI 9"), and
            // reading that as an ABI mismatch told the user to update Axon
            // when the real answer was that no version satisfied their range.
            const abiRejected = cognetFailure.status === "error"
                && cognetFailure.error?.includes(`targets kernel ABI ${KERNEL_ABI_VERSION}`)
            if (abiRejected) {
                throw err("COGNET_ABI_MISMATCH", {
                    detail: `${cognetFailure.error}`,
                    context: { specifier: cognetSpecifier, kernelAbi: KERNEL_ABI_VERSION },
                })
            }
            // Name the registry that answered. "not published in the
            // registry" is a claim about the world made from one endpoint's
            // 404 — and when that endpoint is local staging while the cognet
            // lives in production, the message sends the reader looking for a
            // publishing bug that does not exist.
            const registry = resolveDefaultBaseUrl()
            throw err("COGNET_NOT_FOUND", {
                detail: cognetFailure.status === "not-found"
                    ? `cognet "${cognetSpecifier}" was not found in the registry at ${registry}`
                    : `cognet "${cognetSpecifier}" failed to install from ${registry}: ${cognetFailure.error}`,
                context: { specifier: cognetSpecifier, registry },
            })
        }

        const sourceModules: LinkResult[] = []
        for (const module of declaredSources) {
            sourceModules.push(await modules.link(module))
        }

        // A cognet brings its OWN dependencies (zero depends on @arcforge/cognet),
        // and unlike a module those are not resolvable until node_modules is
        // materialized — the bundler resolves the cognet's import graph from
        // the agent's tree. `already-installed` is not sufficient evidence
        // they are present: a cognet version that GAINED a dependency leaves
        // the agent's manifest unchanged while its own deps are missing, which
        // fails at bundle time with an unresolvable import rather than here.
        const cognetNeedsInstall = !(await cognetDependenciesPresent(cognetSource))

        // Reconcile: compare what is DECLARED against what is INSTALLED, and
        // repair the manifest where the two disagree. This is the step whose
        // absence produced every dependency failure worth fixing — a present-
        // but-wrong package reading as installed, a published fix unable to
        // reach an agent holding the broken version, and a replaced cognet
        // lingering in package.json forever.
        //
        // Runs AFTER the installers have declared their ranges (so `managed`
        // reflects this run's intent) and BEFORE the install decision below,
        // which is the thing it informs.
        // A cognet's own runtime dependencies must be declared by the AGENT.
        // The compiled brain leaves them external (a 259MB native ONNX
        // runtime cannot be inlined, and should not be even if it could), so
        // the bare import in the bundle resolves from the agent's tree — the
        // bundle lives in the agent's .agent/cognet/, not the cognet's.
        //
        // Without this the compile succeeds and the agent fails at boot with
        // "Cannot find package", naming a dependency the agent never declared
        // and the author only wrote in the cognet.
        const cognetRuntimeDeps = await cognetDependencyRanges(cognetSource)
        if (Object.keys(cognetRuntimeDeps).length > 0) {
            await manifest.package.dependencies.set(cognetRuntimeDeps)
        }

        const declaredNow = await manifest.package.dependencies.all()
        const managed: Record<string, string> = {}

        // The FRAMEWORK packages, first — they were missing from this set
        // entirely, and that was a hole straight through "the one gate".
        //
        // Their only disk-side check was `tree.frameworkInstalled()`, which
        // is `resolves("@arcforge/types")`: a bare directory-presence test
        // that cannot see a version. So an agent declaring a framework
        // version it did not have on disk — a stale pin, a hand-edit, a
        // node_modules left behind by a different checkout — passed prepare
        // and reported `✓ ready`, then failed at runtime with whatever the
        // wrong copy happened to do. Verified: pinning @arcforge/types to a
        // version that cannot exist still printed `✓ ready`.
        //
        // verify() already answers this correctly for everything in
        // `managed`, including exempting local `workspace:`/`file:` ranges,
        // so the fix is to stop hiding these from it rather than to add a
        // second check beside it.
        for (const name of Object.keys(manifest.package.framework.dependencies(frameworkVersion, frameworkSource, repoRoot, KINDS[kind].framework))) {
            const range = declaredNow[name]
            if (range !== undefined) managed[name] = range
        }

        if (cognetSource.kind === "registry") {
            const name = cognetName(cognetSource.specifier)
            const range = declaredNow[name]
            if (range !== undefined) managed[name] = range
        }
        for (const result of installed) {
            if (result.status === "not-found" || result.status === "error") continue
            const range = declaredNow[result.name]
            if (range !== undefined) managed[result.name] = range
        }

        // What Axon may prune. Ownership must be PROVEN, never guessed: a
        // dependency the user added by hand is not Axon's to remove, and a
        // wrong guess deletes something the agent needs.
        //
        // A dependency is Axon's when it is a COGNET — the one kind of package
        // an agent installs without ever declaring it in `modules: [...]`,
        // and therefore the one that nothing else would ever clean up.
        // Registry modules are already pruned against the config's own
        // modules array by Modules.prune(); this closes the cognet gap that
        // left @axon/zero declared long after the agent switched brains.
        const selectedCognet = cognetSource.kind === "registry" ? cognetName(cognetSource.specifier) : null
        const staleCognets = await cognetDependencies(declaredNow, selectedCognet)

        // Reconcile owns the MANIFEST half: prune what is no longer declared,
        // write the ranges this run intends. It no longer judges the tree —
        // that is verify's job, and having two answers to "is the tree right"
        // is how they drift apart.
        const reconciled = await reconcile({
            manifest,
            tree,
            managed,
            owned: name => name in managed || staleCognets.has(name),
            ...(options.frozen ? { dryRun: true } : {}),
        })

        // Verify owns the DISK half, through the one gate every dependency
        // question resolves to. Run here (rather than only at the top) because
        // `managed` is not knowable until the installers have declared their
        // ranges — this is the first moment the full question can be asked.
        const verified = await tree.verify({ manifest, managed, registryOrigin })

        // --frozen asserts agreement rather than creating it. Anything
        // reconcile had to change, or verify says is incoherent, is drift —
        // and a deploy that silently resolves drift is a deploy that ships
        // something other than what was committed.
        if (options.frozen && (reconciled.changed || !verified.coherent)) {
            throw err("PREPARE_FROZEN_DRIFT", {
                detail: verified.faults.length
                    ? describeFaults(verified.faults)
                    : `package.json was out of sync with axon.config.ts (${reconciled.pruned.join(", ")} no longer declared)`,
                context: { faults: verified.faults, pruned: reconciled.pruned },
            })
        }

        if (
            needsFrameworkInstall
            || cognetNeedsInstall
            || reconciled.changed
            || verified.needsInstall
            || pruned.length > 0
            || installed.some(r => r.status === "installed")
            || cognetInstall.some(r => r.status === "installed")
            || sourceModules.some(r => r.dependenciesChanged)
        ) {
            // A stale package needs its range re-resolved, not merely
            // replayed: the lockfile pin is exactly what is holding it back.
            const refresh = verified.faults.filter(f => f.kind === "stale").map(f => f.name)

            // A dangling graft cannot be installed OVER — bun writes what it
            // resolves and leaves what it did not touch, so the dead links
            // survive. The tree has to go first. Re-checked here as well as at
            // the top because an install earlier in this run can evict the
            // very tree this project was grafted onto.
            if (verified.faults.some(f => f.kind === "dangling")) await tree.clearModules()

            await phase(
                report,
                "build:tree",
                { reason: "reconcile" },
                () => tree.install({
                    ...(refresh.length ? { refresh } : {}),
                    onPropagationRetry: notePropagation,
                }),
            )
        }

        // Cognets version independently of the CLI now, so an agent can pin one
        // built against a kernel ABI this runtime no longer provides. Fail
        // HERE, naming both versions, rather than at agent boot with a mismatch
        // buried inside the compiled bundle.
        // The cognet stage: the ABI gate, then its weights. Bracketed
        // together because they are one question — "can this brain run
        // here" — and because the ABI mismatch is the single most common
        // way a build dies. It threw straight to the terminal before this
        // existed, which is what made a failed boot invisible.
        const resolvedModels = await phase(
            report,
            "build:cognet",
            { specifier: cognetSpecifier },
            async () => {
                const cognetDir = blueprint.cognet.sourceDir(cognetSource)
                await cognetAbi(cognetDir, cognetSpecifier)

                // Weights, before the compile that will carry their paths. A
                // declared model that cannot be fetched fails HERE — a brain
                // without its weights is broken rather than degraded, and
                // finding that out at first inference is far worse than
                // finding it at prepare.
                const declaredModels = await readCognetModels(blueprint.cognet.sourceDir(cognetSource))
                return weights.resolve(declaredModels, {
                    ...(options.frozen ? { frozen: true } : {}),
                    onDownload: model => console.log(`  fetching ${model.key} — ${model.repo}/${model.file}`),
                })
            },
            models => ({
                specifier: cognetSpecifier,
                models: Object.keys(models.paths).length,
            }),
        )

        // compile: true — load() compiles the brain before scanning, because
        // the scan reads the manifest compilation writes. A broken build throws:
        // no brain, no agent.
        const profileProviders = await opts.profileProviders?.()
        const { blueprint: loaded, warnings } = await blueprint.load({
            compile: true,
            ...(Object.keys(resolvedModels.paths).length ? { models: resolvedModels.paths } : {}),
            ...(profileProviders ? { profileProviders: [...profileProviders] } : {}),
        })

        return {
            modules: installed,
            sourceModules,
            typegen: await phase(
                report,
                "build:typegen",
                {},
                () => typegen.write(loaded),
                written => ({ files: Array.isArray(written) ? written : [] }),
            ),
            warnings: [
                ...warnings,
                // A local shadow makes THIS machine disagree with a fresh
                // clone, silently and in the direction that always works
                // here. Surfaced every prepare, because the moment it stops
                // being visible is the moment it starts costing someone a
                // day of debugging a bug only they can't reproduce.
                ...verified.faults.filter(fault => fault.kind === "shadowed").map(fault => ({
                    domain: "dependencies",
                    error: `${fault.name} is pinned to a local workspace copy, not the registry — this agent will not behave like a fresh clone. `
                        + `Set it back to a version range in package.json if that was not deliberate.`,
                })),
                // A range this tool wrote against one registry and then had to
                // rewrite for another. Always surfaced: the manifest changed
                // underneath the user, and the reason (two registries, one
                // package.json) is not something they can infer from the diff.
                ...repairedRanges.map(fixed => ({
                    domain: "dependencies",
                    error: `${fixed.name} was ${fixed.from}, auto-resolved against ${fixed.origin}. `
                        + `That version does not exist here, so it was re-resolved to ${fixed.to}. `
                        + `Switching between registries rewrites this range each time.`,
                })),
            ],
        }
    }
}

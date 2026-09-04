import { join } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { err } from "@arcforge/err"

/**
 * The framework packages every agent needs on disk, and where each lives in
 * this repo.
 *
 * The paths are the reason this is a map rather than a list: a test fixture
 * resolves them from the WORKING TREE instead of npm (see
 * `frameworkSpecifier`), and that requires knowing where each package is.
 */
const FRAMEWORK_PACKAGES = {
    "@arcforge/types": "libs/axon/types",
    "@arcforge/engines": "libs/axon/packages/engines",
    // The cognet runtime the compiled brain fuses to. Every agent needs it
    // installed, because the generated entry imports it by bare specifier
    // and the bundler resolves that from the agent's own node_modules.
    "@arcforge/cognet": "libs/axon/cognet",
    // The grammar a cognet renders with, for the same reason: the bundle
    // marks it external (it is one of the cognet's own declared deps) and
    // then resolves it from HERE. It is framework rather than a carried
    // dependency because the kernel parses with the same package — two
    // copies would be two grammars that could disagree.
    "@arcforge/air": "libs/axon/packages/air",
} as const

/**
 * Framework packages an agent never imports directly, but which the linked
 * ones depend on.
 *
 * In "published" mode npm resolves these transitively and they never need
 * naming. A `file:` link cannot: the linked package declares them
 * `workspace:*`, which only resolves inside a workspace, and a fixture in
 * /tmp is not one. So the whole framework graph is linked, not just its
 * roots — otherwise `bun install` fails with "Workspace dependency not
 * found" on a package the agent has no idea exists.
 */
const FRAMEWORK_TRANSITIVE = {
    "@arcforge/err": "libs/axon/packages/err",
} as const

/**
 * How a framework dependency is spelled in a scaffolded project.
 *
 * "published" — the exact CLI version. What a real user gets: the generated
 * .agent/*.d.ts comes from this CLI, so the installed types must match it
 * exactly or they drift from what the editor was told.
 *
 * "workspace" — a `file:` link into this repo. What the TEST SUITE gets, and
 * the reason this option exists at all.
 *
 * A suite that installs the framework from npm is not testing the commit, it
 * is testing the last release — so a change to a published package could not
 * pass until it was published, and could not be published until it passed.
 * Every symptom of that followed: a green gate on broken code, a barrel
 * export that pulled the TypeScript compiler into every agent bundle and was
 * invisible until an agent installed it, and a release cycle where the only
 * way through was to force a deploy and find out afterwards.
 *
 * Linking makes the fixture resolve the code under test, so those fail here
 * rather than in a user's first-run. `manifest.framework.ensure()` already
 * treats a `file:`/`workspace:` range as deliberate and leaves it alone,
 * which is what lets a linked fixture survive a prepare.
 */
export type FrameworkSource = "published" | "workspace"

function frameworkSpecifier(
    name: keyof typeof FRAMEWORK_PACKAGES,
    frameworkVersion: string,
    source: FrameworkSource,
    repoRoot: string | undefined,
): string {
    if (source === "published" || !repoRoot) return frameworkVersion
    return `file:${join(repoRoot, FRAMEWORK_PACKAGES[name])}`
}

/**
 * The subset of the framework a kind actually needs.
 *
 * "types" is @arcforge/types alone — enough to resolve
 * `tsconfig.base.json` and, through its own dependency on @types/bun, the Bun
 * globals a generated frame assumes. That is the whole requirement of a
 * profile or an extension: neither runs an agent, so neither has any use for
 * the engine registry, the cognet host or the AIR grammar.
 *
 * "all" is the agent set — every package a booting agent resolves by bare
 * specifier out of its own node_modules.
 *
 * Split because a profile declaring the agent framework is not merely
 * wasteful: under `file:` linking the extra links change how the tree hoists,
 * and @types/bun stopped resolving — so a user's plugin lost `Bun` and
 * `process` and every symbol degraded to any.
 */
export type FrameworkSet = "all" | "types"

function frameworkDependencies(
    frameworkVersion: string,
    source: FrameworkSource = "published",
    repoRoot?: string,
    set: FrameworkSet = "all",
): Record<string, string> {
    const deps: Record<string, string> = {}

    if (set === "types") {
        deps["@arcforge/types"] = frameworkSpecifier("@arcforge/types", frameworkVersion, source, repoRoot)

        // Declared OUTRIGHT, not inherited.
        //
        // tsconfig.base.json sets `"types": ["bun"]`, and an explicit `types`
        // field disables automatic @types discovery — so the package making
        // that claim has to guarantee it resolves. @arcforge/types declares
        // @types/bun as a real dependency for exactly this reason, and an
        // AGENT inherits it transitively through a registry package.
        //
        // A profile has no such package. Its only framework dependency is
        // linked with `file:`, and a `file:` link does not install the linked
        // package's own dependencies — Bun expects the surrounding workspace
        // to provide them, and ~/.axon is not one. The result was a frame
        // whose tsconfig named a type library that was not on disk: `Bun`,
        // `process` and `fetch` all unresolved in a user's plugin.
        deps["@types/bun"] = "^1.2.0"

        // A `file:` link resolves the linked package's own `workspace:*`
        // ranges from a directory that is not a workspace, so anything it
        // depends on has to be linked alongside it — same as the agent set.
        if (source === "workspace" && repoRoot) {
            for (const [name, path] of Object.entries(FRAMEWORK_TRANSITIVE)) {
                deps[name] = `file:${join(repoRoot, path)}`
            }
        }
        return deps
    }

    for (const name of Object.keys(FRAMEWORK_PACKAGES) as (keyof typeof FRAMEWORK_PACKAGES)[]) {
        deps[name] = frameworkSpecifier(name, frameworkVersion, source, repoRoot)
    }
    // Only when linking: published mode resolves these transitively.
    if (source === "workspace" && repoRoot) {
        for (const [name, path] of Object.entries(FRAMEWORK_TRANSITIVE)) {
            deps[name] = `file:${join(repoRoot, path)}`
        }
    }
    // h3 is a real npm dependency in every mode — it is not ours, so there is
    // no working tree to point at.
    deps.h3 = "^1.13.0"
    return deps
}

export type PackageJson = {
    name?: string
    version?: string
    description?: string
    private?: boolean
    dependencies?: Record<string, string>
    /**
     * Axon's own bookkeeping, namespaced so it cannot collide with npm's
     * fields or another tool's.
     *
     * `trackedFrom` maps a dependency name to the registry base URL its range
     * was AUTO-RESOLVED against. Only ranges Axon wrote itself appear here —
     * a user's pin is their claim and carries no origin.
     */
    axon?: {
        trackedFrom?: Record<string, string>
    }
} & Record<string, unknown>

type PackageOpts = {
    root: string
}

/**
 * package.json — the project's identity and declared dependencies.
 *
 * The single reader and writer of this file. There used to be four
 * implementations of "parse the project's package.json" (dependencies.ts,
 * version.ts, installer.ts, bundle/manifest.ts), each with slightly different
 * error behaviour.
 */
export function Package(opts: PackageOpts) {
    const path = join(opts.root, "package.json")

    async function read(): Promise<PackageJson> {
        // A missing or unparseable manifest is a legible PROJECT failure, and
        // this is the single reader — so the translation happens once, here,
        // rather than at each of the dozen call sites.
        //
        // It used to escape raw. `bundle()` runs `prepare()` first, which
        // reaches this through `dependencies.ensure()`, so a project with no
        // package.json failed with `ENOENT ... open '/tmp/.../package.json'`
        // long before Artifacts.identity() — which raises a proper
        // BUNDLE_INVALID naming the root — ever ran. The careful error existed
        // and was simply unreachable.
        let source: string
        try {
            source = await readFile(path, "utf-8")
        } catch (cause) {
            throw err("BUNDLE_INVALID", { detail: `no package.json at ${opts.root}`, context: { root: opts.root, path }, cause })
        }
        try {
            return JSON.parse(source) as PackageJson
        } catch (cause) {
            throw err("BUNDLE_INVALID", { detail: `package.json at ${opts.root} is not valid JSON`, context: { root: opts.root, path }, cause })
        }
    }

    async function write(pkg: PackageJson): Promise<void> {
        await writeFile(path, JSON.stringify(pkg, null, 2) + "\n")
    }

    /** Increment a semver patch component. Published versions are immutable. */
    function bumpPatch(version: string): string {
        const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
        if (!match) {
            throw err("VERSION_INVALID", {
                detail: `expected semver, received "${version}"`,
                context: { version: version },
            })
        }
        return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
    }

    /**
     * The declared dependency map.
     *
     * Every mutation of it goes through here, because several callers edit it
     * for unrelated reasons — Installer adds registry ranges, source modules
     * add and prune `file:` specifiers, framework pinning corrects @arcforge
     * versions. Each used to read-modify-write package.json itself, which is a
     * lost update waiting to happen the moment two of them run in one prepare.
     */
    const dependencies = {
        async all(): Promise<Record<string, string>> {
            return (await read()).dependencies ?? {}
        },

        /**
         * Set several dependencies at once. Returns true when the manifest
         * actually changed — the caller's signal that an install is needed.
         *
         * `origins` records which REGISTRY an auto-resolved range came from,
         * under `axon.trackedFrom`. Written in this same read-modify-write
         * rather than beside it, for the reason the block comment above gives:
         * two sequential writes are a lost update.
         *
         * Why it must be recorded at all: a range like "^1.0.5" is derived
         * from whichever registry answered at the time, but it is stored in a
         * manifest read by every later install against whatever registry is
         * configured THEN. Without the origin the two are indistinguishable,
         * and a range resolved against local staging permanently breaks
         * installs against production — which is exactly what happened to
         * @axon/zero@^1.0.5, a version that only ever existed on localhost.
         */
        async set(entries: Record<string, string>, origins?: Record<string, string>): Promise<boolean> {
            const pkg = await read()
            const declared = { ...(pkg.dependencies ?? {}) }

            let changed = false
            for (const [name, specifier] of Object.entries(entries)) {
                if (declared[name] === specifier) continue
                declared[name] = specifier
                changed = true
            }

            const axon = { ...(pkg.axon ?? {}) } as { trackedFrom?: Record<string, string> }
            if (origins && Object.keys(origins).length > 0) {
                const trackedFrom = { ...(axon.trackedFrom ?? {}) }
                for (const [name, origin] of Object.entries(origins)) {
                    if (trackedFrom[name] === origin) continue
                    trackedFrom[name] = origin
                    changed = true
                }
                axon.trackedFrom = trackedFrom
            }

            if (changed) {
                await write({
                    ...pkg,
                    dependencies: declared,
                    ...(axon.trackedFrom ? { axon } : {}),
                })
            }
            return changed
        },

        /**
         * Which registry an auto-resolved range was derived from, if recorded.
         *
         * Absent for every range the USER pinned — those are their claim about
         * what they want, not ours about what a registry answered, and must
         * never be re-resolved out from under them.
         */
        async trackedFrom(): Promise<Record<string, string>> {
            const pkg = await read()
            return (pkg.axon as { trackedFrom?: Record<string, string> } | undefined)?.trackedFrom ?? {}
        },

        /** Drop dependencies by name. Returns the names that were actually present. */
        async remove(names: string[]): Promise<string[]> {
            const pkg = await read()
            const declared = { ...(pkg.dependencies ?? {}) }

            const removed = names.filter(name => name in declared)
            if (removed.length === 0) return []

            for (const name of removed) delete declared[name]
            await write({ ...pkg, dependencies: declared })
            return removed
        },
    }

    const framework = {
        dependencies: frameworkDependencies,

        /**
         * Ensure package.json declares the framework deps at the pinned
         * version, adding or correcting them in place. Returns true when it
         * changed anything — the caller's signal that an install is needed.
         * This is what self-heals agents scaffolded before the npm-deps model
         * (they had these types injected via machine-local tsconfig paths, and
         * declare none of them).
         */
        async ensure(frameworkVersion: string, source: FrameworkSource = "published", repoRoot?: string, set: FrameworkSet = "all"): Promise<boolean> {
            const declared = await dependencies.all()

            // h3 is a range the user may legitimately widen; only add it if
            // absent. The @arcforge packages are exact-pinned to the CLI and
            // corrected if they drift, since a mismatch against the generated
            // .d.ts is a bug.
            //
            // A `workspace:`/`file:` range is exempt, because it is not drift
            // — it is someone deliberately pointing at a local checkout, which
            // is how the framework itself is developed. Correcting it made
            // that impossible: every prepare rewrote the link back to the
            // published version, so a change to the cognet host could never be
            // exercised by an agent without hand-patching node_modules after
            // every single run.
            const isLocal = (range: string | undefined) =>
                range !== undefined && (range.startsWith("workspace:") || range.startsWith("file:"))

            const required = Object.entries(frameworkDependencies(frameworkVersion, source, repoRoot, set))
                .filter(([name, version]) =>
                    declared[name] === undefined
                    || (name.startsWith("@arcforge/") && !isLocal(declared[name]) && declared[name] !== version))

            // Linked packages declare their OWN deps as `workspace:*`, which
            // resolves only inside a workspace — and a fixture in /tmp is not
            // one. `overrides` redirects those at the same links, which is
            // what makes the whole framework graph resolve from the tree.
            //
            // Written in the SAME read-modify-write as the dependencies, not
            // beside it. Two sequential writes are a lost update: the second
            // read happens before the first has landed, so whichever wrote
            // last silently discarded the other's change — which is exactly
            // what happened, leaving a manifest with overrides and no
            // framework dependencies at all.
            const links = source === "workspace" && repoRoot
                ? Object.fromEntries(
                    Object.entries(frameworkDependencies(frameworkVersion, source, repoRoot, set))
                        .filter(([, spec]) => spec.startsWith("file:")),
                )
                : {}

            if (required.length === 0 && Object.keys(links).length === 0) return false

            const pkg = await read()
            const nextDeps = { ...(pkg.dependencies ?? {}), ...Object.fromEntries(required) }
            const nextOverrides = { ...((pkg.overrides ?? {}) as Record<string, string>), ...links }

            const changed = JSON.stringify(pkg.dependencies) !== JSON.stringify(nextDeps)
                || JSON.stringify(pkg.overrides) !== JSON.stringify(nextOverrides)
            if (!changed) return false

            await write({
                ...pkg,
                dependencies: nextDeps,
                ...(Object.keys(nextOverrides).length > 0 ? { overrides: nextOverrides } : {}),
            })
            return true
        },
    }

    return {
        path: path,
        read: read,
        write: write,
        bumpPatch: bumpPatch,
        dependencies: dependencies,
        framework: framework,

        /** Merge fields into package.json, preserving everything else. */
        async update(fields: Partial<PackageJson>): Promise<void> {
            await write({ ...(await read()), ...fields })
        },

        /** Persist the next patch version; callers rebuild so every artifact agrees. */
        async bump(version: string): Promise<string> {
            const next = bumpPatch(version)
            await write({ ...(await read()), version: next })
            return next
        },
    }
}

export type PackageT = ReturnType<typeof Package>

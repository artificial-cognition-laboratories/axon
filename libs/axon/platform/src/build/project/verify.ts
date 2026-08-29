import { join } from "node:path"
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs"
import { satisfies, validRange } from "semver"
import type { ManifestT } from "./manifest"

/**
 * Verify — is what is on disk coherent with what the project declares?
 *
 * THE CONCEPT THIS SYSTEM WAS MISSING. Every dependency incident worth fixing
 * has been the same shape: state on disk disagreed with state in the manifest,
 * and nothing checked before trusting it. Each was then patched with its own
 * bespoke repair bolted to the front of `prepare`:
 *
 *   - a package present at the WRONG VERSION passed as installed, because
 *     installed-ness was `existsSync(dir)`
 *   - a range auto-resolved against a DIFFERENT REGISTRY was honoured as a
 *     pin forever, so every install failed on a version that only existed on
 *     one machine (@axon/zero@^1.0.5)
 *   - a node_modules of DANGLING LINKS read as installed, because the shared
 *     tree cache it was grafted onto had been evicted
 *   - a cognet whose bundle targets a stale KERNEL ABI compiled and then failed
 *     at load
 *
 * Four incidents, four repairs, four places to remember. This is the single
 * question all of them are asking, so a FIFTH incident becomes a new Fault
 * variant rather than another line at the top of prepare.
 *
 * Faults are DESCRIPTIVE, never repaired here. Detection and repair are split
 * deliberately: `--frozen` must be able to ask this exact question and refuse,
 * and a check that fixes what it finds can never fail. The caller decides.
 */

/** Why a project's installed state disagrees with what it declares. */
export type Fault =
    /** Declared but absent from node_modules, or present and unreadable. */
    | { kind: "missing"; name: string; range: string }
    /** Present, but its version falls outside the range now declared. */
    | { kind: "stale"; name: string; range: string; installed: string }
    /**
     * The package's directory is a symlink pointing at something that no
     * longer exists — a graft onto a shared cache tree that has been evicted.
     *
     * Distinct from `missing` because the cause is MACHINE STATE, not the
     * manifest: the user changed nothing and no edit to their config will fix
     * it. Reporting it as missing sends them looking for a typo.
     */
    | { kind: "dangling"; name: string; link: string; target: string }
    /**
     * The range was auto-resolved against a different registry than the one
     * now configured, so it may name a version this registry never had.
     *
     * Only ever reported for ranges Axon WROTE (`axon.trackedFrom`). A range
     * the user pinned carries no origin and is never second-guessed.
     */
    | { kind: "foreign"; name: string; range: string; origin: string; current: string }
    /**
     * Declared at a local `workspace:`/`file:` range while Axon manages it
     * from the registry — this machine will not behave like a fresh clone.
     *
     * Reported, never repaired: pointing an agent at a local checkout on
     * purpose is legitimate, and rewriting someone's manifest on suspicion is
     * worse than the drift.
     */
    | { kind: "shadowed"; name: string; range: string }
    /**
     * bunfig.toml maps a scope at a DIFFERENT registry than the one now
     * configured, so bun would fetch tarballs from the wrong place.
     *
     * The sharpest form of registry mixing, because it splits one install in
     * half: ranges resolve against the current registry while the bytes come
     * from the old one. `trackedFrom` cannot catch it — that describes a
     * range, and this is about where the package is FETCHED.
     */
    | { kind: "registry"; scope: string; mapped: string; current: string }

export type VerifyReport = {
    /** True when nothing needs to change on disk. */
    coherent: boolean
    faults: Fault[]
    /**
     * Faults that repair by installing, as opposed to those needing a
     * manifest edit or no action at all. Lets a caller answer "must I install"
     * without re-deriving it from the fault kinds.
     */
    needsInstall: boolean
}

export type VerifyOpts = {
    root: string
    manifest: ManifestT
    /**
     * Every dependency Axon manages, and the range each should be at — the
     * cognet plus registry modules. Anything absent is the user's own
     * dependency and is never inspected.
     */
    managed: Record<string, string>
    /** The registry auto-resolved ranges are attributed to, for `foreign`. */
    registryOrigin: string
    /** Installed version of a package, or null. Supplied by Tree. */
    installedVersion(name: string): string | null
    /** Where a package resolved to, or null. Supplied by Tree. */
    locate(name: string): string | null
}

/** A local range is a deliberate link, not a registry install. */
function isLocal(range: string): boolean {
    return range.startsWith("workspace:") || range.startsWith("file:")
}

/**
 * The dangling symlink standing where a package should be, if there is one.
 *
 * Checks the package path AND its scope directory, because a grafted tree
 * links whole top-level entries ("@axon"), not individual packages inside
 * them — so an evicted tree shows up one level above the name being resolved.
 */
function danglingAt(root: string, name: string): { link: string; target: string } | null {
    const [scope] = name.split("/")
    const candidates = [
        join(root, "node_modules", ...name.split("/")),
        ...(name.startsWith("@") ? [join(root, "node_modules", scope!)] : []),
    ]
    for (const link of candidates) {
        try {
            if (!lstatSync(link).isSymbolicLink()) continue
            if (existsSync(link)) continue
            return { link, target: readlinkSync(link) }
        } catch {
            // Not a link, or gone entirely — `missing` covers that case.
        }
    }
    return null
}

/**
 * Is node_modules present but composed ENTIRELY of dangling links?
 *
 * The signature of a grafted project whose cache tree was deleted. Checked as
 * a whole-tree property rather than per package because that is what makes it
 * distinguishable from a partial install still in progress.
 */
export function graftBroken(root: string): boolean {
    const modules = join(root, "node_modules")
    if (!existsSync(modules)) return false
    let entries: string[]
    try {
        entries = readdirSync(modules).filter(name => !name.startsWith("."))
    } catch {
        return false
    }
    if (entries.length === 0) return false
    return entries.every(entry => {
        const path = join(modules, entry)
        try {
            return lstatSync(path).isSymbolicLink() && !existsSync(path)
        } catch {
            return false
        }
    })
}

/**
 * Compare every managed dependency against what is actually on disk.
 *
 * Pure inspection — reads the manifest and the filesystem, writes nothing.
 */
export async function verify(opts: VerifyOpts): Promise<VerifyReport> {
    const origins = await opts.manifest.package.dependencies.trackedFrom()
    const faults: Fault[] = []

    // Where tarballs are FETCHED from, which is a different question than
    // where a range was resolved. A bunfig left pointing at a previous run's
    // registry splits an install in half — current ranges, stale bytes — and
    // nothing about the manifest reveals it.
    //
    // Only scopes Axon actually serves are inspected: an agent legitimately
    // depends on ordinary npm packages, and those must keep resolving against
    // public npm.
    const mappedScopes = await opts.manifest.bunfig.scopes()
    const managedScopes = new Set(
        Object.keys(opts.managed)
            .map(name => opts.manifest.bunfig.scopeOf(name))
            .filter((scope): scope is string => scope !== null),
    )
    for (const [scope, mapped] of Object.entries(mappedScopes)) {
        if (!managedScopes.has(scope)) continue
        if (mapped.startsWith(opts.registryOrigin)) continue
        faults.push({ kind: "registry", scope, mapped, current: opts.registryOrigin })
    }

    for (const [name, range] of Object.entries(opts.managed)) {
        if (isLocal(range)) {
            // A workspace range on something Axon installs from the registry
            // is reported but never touched. It changes nothing on disk, so it
            // must not make --frozen fail either.
            if (range.startsWith("workspace:")) faults.push({ kind: "shadowed", name, range })
            continue
        }

        // Origin first: a foreign range makes every other question about this
        // package meaningless, because the range itself names a version that
        // may not exist here. Repairing it re-resolves and the rest follows.
        const origin = origins[name]
        if (origin !== undefined && origin !== opts.registryOrigin) {
            faults.push({ kind: "foreign", name, range, origin, current: opts.registryOrigin })
            continue
        }

        // A dangling link is checked before absence, because `installedVersion`
        // reports both as null and only one of them is the user's problem.
        const dangling = danglingAt(opts.root, name)
        if (dangling) {
            faults.push({ kind: "dangling", name, ...dangling })
            continue
        }

        const installed = opts.installedVersion(name)
        if (installed === null) {
            faults.push({ kind: "missing", name, range })
            continue
        }

        // An unparseable range is not evidence of a problem: it may be a tag
        // or a URL Bun understands and semver does not. Presence is the most
        // that can be checked, and it passed.
        if (!validRange(range)) continue

        if (!satisfies(installed, range)) {
            faults.push({ kind: "stale", name, range, installed })
        }
    }

    // Shadowing is deliberately not incoherence: nothing on disk needs to
    // change, so a monorepo must still be able to freeze.
    const actionable = faults.filter(fault => fault.kind !== "shadowed")

    return {
        faults,
        coherent: actionable.length === 0,
        // A `registry` fault forces an install: the bytes on disk came from
        // the wrong registry, so re-resolving is the only way to correct them.
        needsInstall: actionable.some(fault =>
            fault.kind === "missing" || fault.kind === "stale"
            || fault.kind === "dangling" || fault.kind === "registry"),
    }
}

/** Render faults as the reason an install is running — or why `--frozen` refused. */
export function describeFaults(faults: Fault[]): string {
    return faults
        .map(fault => {
            switch (fault.kind) {
                case "missing":
                    return `${fault.name} (${fault.range}) is declared but not installed`
                case "stale":
                    return `${fault.name} is at ${fault.installed}, outside the declared ${fault.range}`
                case "dangling":
                    return `${fault.name} points at ${fault.target}, which no longer exists`
                case "foreign":
                    return `${fault.name} (${fault.range}) was resolved against ${fault.origin}, not ${fault.current}`
                case "shadowed":
                    return `${fault.name} is pinned to a local copy (${fault.range})`
                case "registry":
                    return `@${fault.scope} fetches from ${fault.mapped}, not ${fault.current}`
            }
        })
        .join("; ")
}

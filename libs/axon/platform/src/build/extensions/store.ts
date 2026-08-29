import { existsSync, readdirSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { rcompare, valid } from "semver"

/**
 * ExtensionStore — fetched extensions, shared by every profile on the machine.
 *
 * ── Why not per profile ─────────────────────────────────────────────────────
 *
 * A registry extension is an ARTIFACT: source, a generated type frame, and a
 * `node_modules` holding `@arcforge/types` and `@types/bun`. Nothing in it
 * depends on the profile that fetched it — the frame is generated from the
 * contract, and the tsconfig `extends` out of the extension's own
 * node_modules, which travels with it.
 *
 * So a copy per profile was a full `bun install` and a `prepare()` per profile
 * for identical bytes. Profiles now REFERENCE what the machine holds, which is
 * the same shape `~/.axon/models/` already uses for weights: one copy, many
 * consumers, "so ten agents share one copy of a 150MB model".
 *
 * ── Keyed by version, not content ───────────────────────────────────────────
 *
 * `<scope>/<name>/<version>/`. A model weight is content-addressed because its
 * hash IS its identity and nobody thinks in versions; an extension is the
 * opposite — the version is exactly what a user reasons about, and it is what
 * `profile.config.ts` pins. Content-addressing would only dedup identical
 * bytes across versions, which is worth nothing here.
 *
 * Versioned also means two profiles can hold DIFFERENT versions at once
 * without either silently changing under the other. That is the property a
 * shared store has to have to be safe.
 *
 * ── Local extensions never come here ────────────────────────────────────────
 *
 * A path entry (`./themes`) is the user's own source: it changes as they edit
 * it, hot reload watches it in place, and copying it into a shared store would
 * make the copy the thing that loads. Only registry entries are stored.
 */

type ExtensionStoreOpts = {
    /** Override the store root. Tests point this at a scratch dir. */
    root?: string
}

/** One stored extension. */
export type StoredExtension = {
    /** Scoped registry name — "@cody/ember-theme". */
    name: string
    version: string
    /** Absolute path to its directory — what the loader imports from. */
    root: string
}

function defaultRoot(): string {
    return process.env.AXON_EXTENSIONS_DIR ?? join(homedir(), ".axon", "cache", "extensions")
}

/**
 * Split "@cody/ember-theme@0.1.0" into its name and version.
 *
 * The leading `@` of a scope is not a separator, so the version delimiter is
 * the LAST `@` — and only when it is not at position zero. A bare name returns
 * a null version, which is what an unpinned entry looks like.
 */
export function parseRef(ref: string): { name: string; version: string | null } {
    const at = ref.lastIndexOf("@")
    if (at <= 0) return { name: ref, version: null }
    return { name: ref.slice(0, at), version: ref.slice(at + 1) }
}

/** The inverse of parseRef. */
export function formatRef(name: string, version: string): string {
    return `${name}@${version}`
}

export function ExtensionStore(opts: ExtensionStoreOpts = {}) {
    const root = opts.root ?? defaultRoot()

    /** Where a given name+version lives. Pure — no I/O. */
    function pathFor(name: string, version: string): string {
        return join(root, ...name.split("/"), version)
    }

    /** A directory is a usable extension when it carries the marker config. */
    function isUsable(dir: string): boolean {
        return existsSync(join(dir, "extension.config.ts"))
    }

    return {
        get root() {
            return root
        },

        pathFor,
        isUsable,

        /**
         * Every version of `name` present, NEWEST FIRST.
         *
         * Ordered by semver, not lexically. It was lexical, defended as "a
         * list that is almost always one element long" — and that assumption
         * dies the moment a user updates twice: `"0.10.0" < "0.9.0"` as
         * strings, so an unpinned entry resolved to the OLDER copy and stayed
         * there. `semver` is already a dependency of this package (see
         * services/update), so the comparator costs an import.
         *
         * A directory whose name is not valid semver is DROPPED rather than
         * sorted to one end. Only an install writes these, and it writes the
         * version the registry resolved — so a non-semver directory is
         * something else that got in, and guessing where it belongs in a
         * version order is how a stray folder becomes "the newest version".
         *
         * Prereleases are ORDERED, not excluded. npm hides them from a range
         * because a range is a standing request that must not drift onto
         * unstable ground; this list only ever answers an unpinned entry,
         * which is the legacy shape. Nothing in publishing produces a
         * prerelease today, so the only way one is present is that a user
         * pinned it deliberately — and a pinned ref never reaches here.
         * Excluding them would mean an explicitly fetched version silently
         * failing to resolve.
         */
        versions(name: string): string[] {
            const dir = join(root, ...name.split("/"))
            if (!existsSync(dir)) return []
            return readdirSync(dir, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && isUsable(join(dir, entry.name)))
                .map(entry => entry.name)
                .filter(version => valid(version) !== null)
                .sort(rcompare)
        },

        /**
         * Resolve a ref to what is on disk, or null.
         *
         * A pinned ref resolves to exactly that version or to nothing — never
         * to a neighbour, because silently loading a version the config does
         * not name is how a pinned config stops meaning anything.
         *
         * An unpinned ref takes the newest present. That is the legacy shape,
         * kept working so a config written before pinning still loads.
         */
        resolve(ref: string): StoredExtension | null {
            const { name, version } = parseRef(ref)

            if (version) {
                const dir = pathFor(name, version)
                return isUsable(dir) ? { name, version, root: dir } : null
            }

            // versions() is newest-first, so the newest IS the first.
            const newest = this.versions(name)[0]
            if (!newest) return null
            return { name, version: newest, root: pathFor(name, newest) }
        },

        /** Every stored extension, for `axon ext prune` and diagnostics. */
        list(): StoredExtension[] {
            if (!existsSync(root)) return []

            const out: StoredExtension[] = []
            // Two levels for a scoped name (@cody/theme), one for a bare one.
            for (const outer of readdirSync(root, { withFileTypes: true })) {
                if (!outer.isDirectory()) continue
                const outerPath = join(root, outer.name)

                if (outer.name.startsWith("@")) {
                    for (const inner of readdirSync(outerPath, { withFileTypes: true })) {
                        if (!inner.isDirectory()) continue
                        const name = `${outer.name}/${inner.name}`
                        for (const version of this.versions(name)) {
                            out.push({ name, version, root: pathFor(name, version) })
                        }
                    }
                    continue
                }

                for (const version of this.versions(outer.name)) {
                    out.push({ name: outer.name, version, root: pathFor(outer.name, version) })
                }
            }
            return out
        },

        /**
         * Delete one stored version.
         *
         * Deliberately NOT what uninstall calls. Uninstalling from a profile
         * only undeclares — another profile may be loading the same copy, and
         * removing it would break a terminal the user was not touching.
         * Reclaiming disk is its own explicit act.
         */
        async remove(name: string, version: string): Promise<void> {
            await rm(pathFor(name, version), { recursive: true, force: true })
        },
    }
}

export type ExtensionStoreT = ReturnType<typeof ExtensionStore>

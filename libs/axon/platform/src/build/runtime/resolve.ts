import { existsSync } from "node:fs"
import { isAbsolute, join, resolve as resolvePath } from "node:path"
import { homedir } from "node:os"
import { err } from "@arcforge/err"
import type { StoreT } from "../../services/store"

type ResolveOpts = {
    store: StoreT
    /** Directory a relative ref is resolved against — the script's own location, not the agent's. */
    cwd: string
}

/**
 * How a caller wrote the reference. Kept on the result because the two
 * halves answer different questions: a path is a statement about WHERE an
 * agent is, so a miss is the caller's mistake; a name is a request to go
 * looking, so a miss means "not installed anywhere" and may be worth
 * fetching.
 */
export type RefKind = "path" | "name"

export type ResolvedAgent = {
    /** Absolute path to the agent directory. Guaranteed to contain axon.config.ts. */
    root: string
    kind: RefKind
    /** The reference as written, for error messages and correlation. */
    ref: string
    /** Which pool it came from — a watched checkout or the installed agents dir. */
    pool: "watched" | "installed" | "path"
}

/**
 * A path is anything explicitly anchored: relative, home-relative, or
 * absolute. A bare `barry` is a NAME — it is looked up, not resolved
 * against cwd — which is what makes short refs portable between scripts.
 *
 * A scoped name (`@cody/barry`) contains a slash but is NOT a path. The
 * scope is part of the agent's identity, not a statement about where it
 * lives, so it is checked first.
 */
function isPathRef(ref: string): boolean {
    if (ref.startsWith("@")) return false
    return ref.startsWith(".") || ref.startsWith("~") || isAbsolute(ref) || ref.includes("/")
}

function expandHome(ref: string): string {
    return ref.startsWith("~") ? join(homedir(), ref.slice(1)) : ref
}

/** The one test for "is there an agent here" — matches what Blueprint() will read. */
function isAgentDir(root: string): boolean {
    return existsSync(join(root, "axon.config.ts"))
}

/**
 * Resolve — an agent reference to a directory on disk.
 *
 * LOCAL ONLY. Resolution never touches the network, in any branch, for any
 * kind of reference. `axon install` is the sole acquisition path; running
 * an agent is pure disk.
 *
 * That split is the design, not an optimization. A command that sometimes
 * fetches is a command whose failure modes cannot be predicted: it breaks
 * offline, hangs on a slow link, and in CI pulls a version nobody
 * reviewed. Worse, whatever it silently installed then shadows the
 * checkout being worked on — the exact bug this shape replaced, where
 * editing an agent's source did nothing because a stale clone from a
 * previous run answered first.
 *
 * Never boots, never prepares, never loads a blueprint, never installs.
 * Returns a directory and how it was found.
 */
export function Resolve(opts: ResolveOpts) {
    const { store } = opts

    /**
     * The active profile's agent surface. Named refs are profile-scoped —
     * they resolve against the logged-in user's own pools — so being
     * logged out is a real failure with its own message rather than an
     * empty search that reports "no agent named x".
     */
    function agents() {
        const active = store.profiles.active()
        // NOT_AUTHENTICATED, not AGENT_NOT_FOUND: "you are logged out" and
        // "that agent does not exist" are different problems with different
        // fixes, and the caller that distinguishes them (the TUI's login
        // prompt) keys off the code.
        if (!active) throw err("NOT_AUTHENTICATED")
        return active.agents
    }

    /** Every pool searched, in order, for an error message that can teach. */
    function searched(): string[] {
        return agents().pools().map(pool => `${pool.root} (${pool.kind})`)
    }

    return {
        /**
         * Resolve one reference against local pools.
         *
         * A path says WHERE an agent is, so a miss is the caller's mistake.
         * A name is a request to go looking, so a miss means "not installed
         * anywhere" and the fix is `axon install` — never an implicit fetch
         * on the way to running something.
         */
        async one(ref: string): Promise<ResolvedAgent> {
            if (isPathRef(ref)) {
                const root = resolvePath(opts.cwd, expandHome(ref))
                if (!isAgentDir(root)) {
                    // A path says where the agent IS. Looking elsewhere
                    // would be guessing at what the caller meant.
                    throw err("PROJECT_NOT_FOUND", { context: { ref, path: root } })
                }
                return { root, kind: "path", ref, pool: "path" }
            }

            const matches = agents().find(ref).filter(match => isAgentDir(match.root))

            if (matches.length === 0) {
                throw err("AGENT_NOT_FOUND", { context: { ref, searched: searched() } })
            }

            // A watched checkout shadowing its own installed copy is the
            // normal case, not a conflict: watching a directory IS the
            // statement that the checkout is the one being worked on. So
            // the watched tier wins outright, and ambiguity is only ever
            // asked WITHIN a tier — two checkouts, or two installs.
            const watched = matches.filter(match => match.kind === "watched")
            const tier = watched.length > 0 ? watched : matches

            // Within a tier there is no correct way to guess. Picking by
            // search order silently runs an agent nobody asked for.
            if (tier.length > 1) {
                throw err("AGENT_AMBIGUOUS", {
                    context: { ref, found: tier.map(match => `${match.root} (${match.kind})`) },
                })
            }

            const match = tier[0]!
            return { root: match.root, kind: "name", ref, pool: match.kind }
        },

        /**
         * Resolve a whole set before any of them boots.
         *
         * Rejects on the first failure:
         * a fleet either comes up whole or not at all, and a caller
         * holding two working agents and one broken one is the outcome
         * this exists to prevent.
         */
        async all<T extends Record<string, string>>(refs: T): Promise<{ [K in keyof T]: ResolvedAgent }> {
            const names = Object.keys(refs) as (keyof T)[]
            const resolved = await Promise.all(names.map(name => this.one(refs[name] as string)))
            return Object.fromEntries(names.map((name, i) => [name, resolved[i]])) as { [K in keyof T]: ResolvedAgent }
        },
    }
}

export type ResolveT = ReturnType<typeof Resolve>

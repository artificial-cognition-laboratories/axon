import type { HttpClient } from "../platform/http"
import { num, record, rows, str, strOrNull } from "../platform/parse"
import type { ArtifactKind } from "./artifacts/types"
import type { ActivityRange } from "./registry"

export type ScopeLink = { label: string; url: string }

/** Whether a scope is backed by a user account or an org. */
export type ScopeKind = "user" | "org"

/**
 * The profile half of a namespace. Deliberately the SAME shape for users and
 * orgs — a scope page renders one way, and `kind` exists for the few places
 * that genuinely differ (an org lists members, a user doesn't).
 */
export type ScopeProfile = {
    name: string | null
    bio: string | null
    avatarUrl: string | null
    website: string | null
    links: ScopeLink[]
    location: string | null
    createdAt: string
}

/** One published artifact as it appears on a scope page. */
export type ScopeArtifact = {
    artifactId: string
    kind: ArtifactKind
    /** The full scoped name — "@axon/obsidian". Also its URL. */
    name: string
    description: string | null
    latestVersion: string | null
    starsCount: number
    /** Lifetime installs, rolled up from the metric log — not a column on the artifact row. */
    installsCount: number
    createdAt: string
}

/**
 * A namespace's rollup numbers — the sum across everything it publishes.
 * Deliberately the same shape as ArtifactStats minus `starredByMe`, which
 * has no meaning for a namespace: the charts are the same components.
 */
export type ScopeStats = {
    installsTotal: number
    starsTotal: number
    daily: Array<{ date: string; installs: number; stars: number }>
}

export type Scope = {
    kind: ScopeKind
    /** The slug without its "@". */
    slug: string
    /**
     * Long-form markdown the namespace wrote about itself, rendered above what
     * it publishes. Owned by the namespace rather than by the user or org row
     * behind it — /@scope is one page whichever kind backs it.
     */
    readme: string | null
    profile: ScopeProfile
    artifacts: ScopeArtifact[]
}

function parseLinks(value: unknown): ScopeLink[] {
    if (!Array.isArray(value)) return []
    return value.filter(
        (l): l is ScopeLink =>
            !!l && typeof l === "object" && typeof l.label === "string" && typeof l.url === "string",
    )
}

type ScopesOpts = {
    http: HttpClient
}

/**
 * Namespaces — "@axon", "@cody" — and everything published under them.
 *
 * One leaf for users and orgs because a scope is one concept: which backs a
 * given "@name" is an implementation detail, and the URL must not change if a
 * personal namespace later becomes an org. This replaced a split
 * users-vs-orgs read path that additionally only ever listed agents and
 * modules, hiding cognets, benches, and prompts from every profile.
 *
 * Public — browsing works logged-out.
 */
export function Scopes(opts: ScopesOpts) {
    return {
        /** One namespace + its published artifacts. Accepts "axon" or "@axon". */
        async get(slug: string): Promise<Scope> {
            const bare = slug.startsWith("@") ? slug.slice(1) : slug
            const raw = await opts.http.get<Record<string, unknown>>(
                `/api/scopes/${encodeURIComponent(bare)}`,
            )
            const p = record(raw.profile, "profile")

            return {
                kind: str(raw, "kind") as ScopeKind,
                slug: str(raw, "slug"),
                readme: strOrNull(raw, "readme"),
                profile: {
                    name: strOrNull(p, "name"),
                    bio: strOrNull(p, "bio"),
                    avatarUrl: strOrNull(p, "avatarUrl"),
                    website: strOrNull(p, "website"),
                    links: parseLinks(p.links),
                    location: strOrNull(p, "location"),
                    createdAt: str(p, "createdAt"),
                },
                artifacts: rows(raw.artifacts, "artifacts").map(a => ({
                    artifactId: str(a, "artifactId"),
                    kind: str(a, "kind") as ArtifactKind,
                    name: str(a, "name"),
                    description: strOrNull(a, "description"),
                    latestVersion: strOrNull(a, "latestVersion"),
                    starsCount: num(a, "starsCount"),
                    installsCount: num(a, "installsCount"),
                    createdAt: str(a, "createdAt"),
                })),
            }
        },

        /**
         * Installs, stars, and the activity series for the whole namespace.
         * Separate from get() because the charts refetch it per range, and
         * the artifact list doesn't change when the range does.
         */
        async stats(slug: string, range?: ActivityRange): Promise<ScopeStats> {
            const bare = slug.startsWith("@") ? slug.slice(1) : slug
            const query = range ? `?range=${range}` : ""
            const raw = record(
                await opts.http.get(`/api/scopes/${encodeURIComponent(bare)}/stats${query}`),
                "stats",
            )
            return {
                installsTotal: num(raw, "installs_total"),
                starsTotal: num(raw, "stars_total"),
                daily: rows(raw.daily, "daily").map(day => ({
                    date: str(day, "date"),
                    installs: num(day, "installs"),
                    stars: num(day, "stars"),
                })),
            }
        },
    }
}

export type ScopesHandle = ReturnType<typeof Scopes>

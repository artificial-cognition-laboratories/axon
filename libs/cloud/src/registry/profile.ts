import type { HttpClient } from "../platform/http"
import { num, record, rows, str, strOrNull } from "../platform/parse"

export type ProfileLink = { label: string; url: string }

export type PublicProfile = {
    id: string
    username: string | null
    name: string | null
    bio: string | null
    avatarUrl: string | null
    website: string | null
    links: ProfileLink[]
    location: string | null
    createdAt: string
}

export type PublicCatalogItem = {
    id: string
    name: string
    description: string | null
    latestVersion: string | null
    starsCount: number
    createdAt: string
}

function parseCatalogItem(data: Record<string, unknown>): PublicCatalogItem {
    return {
        id: str(data, "id"),
        name: str(data, "name"),
        description: strOrNull(data, "description"),
        latestVersion: strOrNull(data, "latestVersion"),
        starsCount: num(data, "starsCount"),
        createdAt: str(data, "createdAt"),
    }
}

function parseLinks(value: unknown): ProfileLink[] {
    if (!Array.isArray(value)) return []
    return value.filter((l): l is ProfileLink => !!l && typeof l === "object" && typeof l.label === "string" && typeof l.url === "string")
}

type ProfileOpts = {
    http: HttpClient
}

/** Day-bucketed installs+stars summed across a user's public agents and modules. */
export type PublicProfileDaily = { date: string; installs: number; stars: number }

/** Public registry profiles — "browse the catalog by person." Works logged-out. */
export function Profile(opts: ProfileOpts) {
    return {
        /** One user's public profile + published (non-private) agents and modules, by username. */
        async get(handle: string, input?: { days?: number }): Promise<{ profile: PublicProfile; agents: PublicCatalogItem[]; modules: PublicCatalogItem[]; daily: PublicProfileDaily[] }> {
            const days = input?.days ?? 30
            const raw = await opts.http.get<Record<string, unknown>>(`/api/u/${encodeURIComponent(handle)}?days=${days}`)
            const p = record(raw.profile, "profile")

            return {
                profile: {
                    id: str(p, "id"),
                    username: strOrNull(p, "username"),
                    name: strOrNull(p, "name"),
                    bio: strOrNull(p, "bio"),
                    avatarUrl: strOrNull(p, "avatarUrl"),
                    website: strOrNull(p, "website"),
                    links: parseLinks(p.links),
                    location: strOrNull(p, "location"),
                    createdAt: str(p, "createdAt"),
                },
                agents: rows(raw.agents, "agents").map(parseCatalogItem),
                modules: rows(raw.modules, "modules").map(parseCatalogItem),
                daily: rows(raw.daily, "daily").map(d => ({ date: str(d, "date"), installs: num(d, "installs"), stars: num(d, "stars") })),
            }
        },
    }
}

export type ProfileHandle = ReturnType<typeof Profile>

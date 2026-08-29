import type { HttpClient } from "../../platform/http"
import { bool, num, record, rows, str, strOrNull } from "../../platform/parse"
import { Activity } from "../activity"
import type { OrgCatalogItem, OrgMember, OrgProfile, OrgRole, OrgStats, OrgUpdate } from "./types"

type OrgOpts = {
    slug: string
    http: HttpClient
}

function parseMember(data: Record<string, unknown>): OrgMember {
    return {
        userId: str(data, "userId"),
        username: str(data, "username"),
        name: strOrNull(data, "name"),
        role: str(data, "role") as OrgRole,
        joinedAt: str(data, "joinedAt"),
    }
}

function parseCatalogItem(data: Record<string, unknown>): OrgCatalogItem {
    return {
        id: str(data, "id"),
        name: str(data, "name"),
        description: strOrNull(data, "description"),
        private: bool(data, "private"),
        latestVersion: strOrNull(data, "latestVersion"),
        starsCount: num(data, "starsCount"),
        createdAt: str(data, "createdAt"),
    }
}

/**
 * One org, scoped by slug — profile, settings, and the member roster.
 * Permissions are enforced server-side (owner/admin for mutations,
 * owner-only for delete); this handle just speaks the protocol.
 */
export function Org(opts: OrgOpts) {
    const base = `/api/orgs/${encodeURIComponent(opts.slug)}`

    const activity = Activity({ http: opts.http, path: () => `${base}/activity` })

    return {
        slug: opts.slug,
        activity: activity,

        /** Public profile + member count — works logged-out. */
        async get(): Promise<OrgProfile> {
            const body = await opts.http.get<Record<string, unknown>>(base)
            const raw = record(body.org, "org")
            return {
                id: str(raw, "id"),
                slug: str(raw, "slug"),
                displayName: strOrNull(raw, "displayName"),
                description: strOrNull(raw, "description"),
                avatarUrl: strOrNull(raw, "avatarUrl"),
                website: strOrNull(raw, "website"),
                createdAt: str(raw, "createdAt"),
                memberCount: num(raw, "memberCount"),
            }
        },

        /** Update org fields — owner or admin. */
        async update(input: OrgUpdate): Promise<void> {
            await opts.http.patch(base, {
                ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
                ...(input.avatarUrl !== undefined ? { avatar_url: input.avatarUrl } : {}),
                ...(input.website !== undefined ? { website: input.website } : {}),
            })
        },

        /** Delete the org — owner only. */
        async delete(): Promise<void> {
            await opts.http.delete(base)
        },

        /** Agents published under this org's namespace. */
        async agents(): Promise<OrgCatalogItem[]> {
            const raw = await opts.http.get<Record<string, unknown>>(`${base}/agents`)
            return rows(raw.agents, "agents").map(parseCatalogItem)
        },

        /** Modules published under this org's namespace. */
        async modules(): Promise<OrgCatalogItem[]> {
            const raw = await opts.http.get<Record<string, unknown>>(`${base}/modules`)
            return rows(raw.modules, "modules").map(parseCatalogItem)
        },

        /** Installs+stars summed across every agent and module the org owns, day-bucketed. */
        async stats(days = 30): Promise<OrgStats> {
            const raw = await opts.http.get<Record<string, unknown>>(`${base}/stats?days=${days}`)
            return {
                starsTotal: num(raw, "stars_total"),
                agentsCount: num(raw, "agents_count"),
                modulesCount: num(raw, "modules_count"),
                daily: rows(raw.daily, "daily").map(d => ({
                    date: str(d, "date"),
                    installs: num(d, "installs"),
                    stars: num(d, "stars"),
                })),
            }
        },

        members: {
            /** Roster — members only. */
            async list(): Promise<OrgMember[]> {
                const raw = await opts.http.get<Record<string, unknown>>(`${base}/members`)
                return rows(raw.members, "members").map(parseMember)
            },

            /** Add a user by username — owner or admin. */
            async add(input: { username: string; role?: OrgRole }): Promise<OrgMember> {
                const raw = await opts.http.post<Record<string, unknown>>(`${base}/members`, input)
                return parseMember(record(raw.member, "member"))
            },

            /** Change a member's role — owner or admin; the last owner is protected server-side. */
            async setRole(userId: string, role: OrgRole): Promise<void> {
                await opts.http.patch(`${base}/members/${encodeURIComponent(userId)}`, { role })
            },

            async remove(userId: string): Promise<void> {
                await opts.http.delete(`${base}/members/${encodeURIComponent(userId)}`)
            },
        },
    }
}

export type OrgHandle = ReturnType<typeof Org>

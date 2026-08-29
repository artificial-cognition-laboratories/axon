import type { HttpClient } from "../../platform/http"
import { record, rows, str, strOrNull } from "../../platform/parse"
import { Org } from "./org"
import type { OrgHandle } from "./org"
import type { OrgMembership, OrgRole } from "./types"

type OrgsOpts = {
    http: HttpClient
}

/**
 * Orgs — the caller's memberships plus creation. Everything scoped to a
 * single org (profile, settings, members) lives on the Org(slug) handle:
 *
 *   const org = orgs.org("arclabs")
 *   await org.members.add({ username: "cody" })
 */
export function Orgs(opts: OrgsOpts) {
    return {
        /** Orgs the current user belongs to. */
        async list(): Promise<OrgMembership[]> {
            const raw = await opts.http.get<Record<string, unknown>>("/api/user/orgs")
            return rows(raw.orgs, "orgs").map(data => ({
                id: str(data, "id"),
                slug: str(data, "slug"),
                displayName: strOrNull(data, "displayName"),
                avatarUrl: strOrNull(data, "avatarUrl"),
                role: str(data, "role") as OrgRole,
                joinedAt: str(data, "joinedAt"),
            }))
        },

        /** Create an org — caller becomes owner. Returns the scoped handle. */
        async create(input: { slug: string; displayName?: string; description?: string }): Promise<OrgHandle> {
            const raw = await opts.http.post<Record<string, unknown>>("/api/user/orgs", {
                slug: input.slug,
                ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
            })
            const created = record(raw.org, "org")
            return Org({ slug: str(created, "slug"), http: opts.http })
        },

        /** Scoped handle for one org. */
        org(slug: string): OrgHandle {
            return Org({ slug, http: opts.http })
        },
    }
}

export type OrgsHandle = ReturnType<typeof Orgs>

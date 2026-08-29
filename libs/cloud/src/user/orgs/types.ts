export type OrgRole = "owner" | "admin" | "member"

/** An org from the caller's own membership list. */
export type OrgMembership = {
    id: string
    slug: string
    displayName: string | null
    avatarUrl: string | null
    role: OrgRole
    joinedAt: string
}

/** Public org profile — visible logged-out. */
export type OrgProfile = {
    id: string
    slug: string
    displayName: string | null
    description: string | null
    avatarUrl: string | null
    website: string | null
    createdAt: string
    memberCount: number
}

export type OrgMember = {
    userId: string
    username: string
    name: string | null
    role: OrgRole
    joinedAt: string
}

/** Owner/admin-editable org fields. */
export type OrgUpdate = {
    displayName?: string | null
    description?: string | null
    avatarUrl?: string | null
    website?: string | null
}

/** One agent or module owned by an org — the row shape from GET /api/orgs/[slug]/{agents,modules}. */
export type OrgCatalogItem = {
    id: string
    name: string
    description: string | null
    private: boolean
    latestVersion: string | null
    starsCount: number
    createdAt: string
}

/** Day-bucketed installs+stars summed across everything the org owns, plus the running totals. */
export type OrgStats = {
    starsTotal: number
    agentsCount: number
    modulesCount: number
    daily: Array<{ date: string; installs: number; stars: number }>
}

import type { HttpClient } from "../platform/http"
import { record, str, strOrNull } from "../platform/parse"

export type ProfileLink = { label: string; url: string }

export type MyProfile = {
    id: string
    username: string | null
    name: string | null
    email: string
    bio: string | null
    avatarUrl: string | null
    website: string | null
    links: ProfileLink[]
    location: string | null
    deactivatedAt: string | null
    createdAt: string
}

export type ProfileUpdate = {
    username?: string
    bio?: string | null
    website?: string | null
    links?: ProfileLink[]
    location?: string | null
}

function parseLinks(value: unknown): ProfileLink[] {
    if (!Array.isArray(value)) return []
    return value.filter((l): l is ProfileLink => !!l && typeof l === "object" && typeof l.label === "string" && typeof l.url === "string")
}

function parseProfile(data: Record<string, unknown>): MyProfile {
    return {
        id: str(data, "id"),
        username: strOrNull(data, "username"),
        name: strOrNull(data, "name"),
        email: str(data, "email"),
        bio: strOrNull(data, "bio"),
        avatarUrl: strOrNull(data, "avatarUrl"),
        website: strOrNull(data, "website"),
        links: parseLinks(data.links),
        location: strOrNull(data, "location"),
        deactivatedAt: strOrNull(data, "deactivatedAt"),
        createdAt: str(data, "createdAt"),
    }
}

type MyProfileOpts = {
    http: HttpClient
}

/** The caller's own editable profile — username, bio, avatar, links, location, deactivation. */
export function Profile(opts: MyProfileOpts) {
    return {
        async get(): Promise<MyProfile> {
            return parseProfile(await opts.http.get<Record<string, unknown>>("/api/user/profile"))
        },

        async update(input: ProfileUpdate): Promise<void> {
            await opts.http.patch("/api/user/profile", input)
        },

        /** Upload a new avatar image (max 2MB). Returns the resulting public URL. */
        async setAvatar(image: File | Blob): Promise<string> {
            const form = new FormData()
            form.set("image", image)
            const raw = await opts.http.form<Record<string, unknown>>("/api/user/profile/avatar", form)
            return str(record(raw, "avatar response"), "avatarUrl")
        },

        /** Disable login and hide the public profile — never a delete. Published agents/modules are untouched. */
        async deactivate(): Promise<void> {
            await opts.http.post("/api/user/profile/deactivate", {})
        },
    }
}

export type ProfileHandle = ReturnType<typeof Profile>

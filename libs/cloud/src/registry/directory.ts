import type { HttpClient } from "../platform/http"
import { record, rows, str, strOrNull } from "../platform/parse"

/**
 * A person or organization, as returned by search.
 *
 * `handle` is the route segment — /u/:handle for a user, /orgs/:handle for
 * an org — so a result links without the caller knowing which it got.
 */
export type DirectoryEntry = {
    kind: "user" | "org"
    handle: string
    displayName: string | null
    bio: string | null
    avatarUrl: string | null
}

function parseEntry(data: Record<string, unknown>): DirectoryEntry {
    const kind = str(data, "kind")
    if (kind !== "user" && kind !== "org") {
        throw new Error(`invalid response: unknown directory kind "${kind}"`)
    }
    return {
        kind,
        handle: str(data, "handle"),
        displayName: strOrNull(data, "displayName"),
        bio: strOrNull(data, "bio"),
        avatarUrl: strOrNull(data, "avatarUrl"),
    }
}

type DirectoryOpts = {
    http: HttpClient
}

export function Directory(opts: DirectoryOpts) {
    return {
        /** Public people + org search. Works logged out. */
        async search(input: { query: string; page?: number }): Promise<DirectoryEntry[]> {
            const params = new URLSearchParams({ q: input.query })
            if (input.page) params.set("page", String(input.page))

            const raw = record(
                await opts.http.get(`/api/registry/directory?${params}`),
                "directory response",
            )
            return rows(raw.entries, "entries").map(parseEntry)
        },
    }
}

export type DirectoryHandle = ReturnType<typeof Directory>

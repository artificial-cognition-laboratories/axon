import type { HttpClient } from "../platform/http"
import { rows, str, strOrNull, bool } from "../platform/parse"

export type ActivityItem =
    | { kind: "deployment"; id: string; at: string; agentId: string; status: string }
    | { kind: "agent"; id: string; at: string; name: string; latestVersion: string | null }
    | { kind: "module"; id: string; at: string; name: string; latestVersion: string | null }
    | { kind: "key"; id: string; at: string; name: string; isActive: boolean }

function parseItem(data: Record<string, unknown>): ActivityItem {
    const kind = str(data, "kind")
    const id = str(data, "id")
    const at = str(data, "at")

    switch (kind) {
        case "deployment":
            return { kind, id, at, agentId: str(data, "agentId"), status: str(data, "status") }
        case "agent":
            return { kind, id, at, name: str(data, "name"), latestVersion: strOrNull(data, "latestVersion") }
        case "module":
            return { kind, id, at, name: str(data, "name"), latestVersion: strOrNull(data, "latestVersion") }
        case "key":
            return { kind, id, at, name: str(data, "name"), isActive: bool(data, "isActive") }
        default:
            throw new Error(`invalid response: unknown activity kind "${kind}"`)
    }
}

type ActivityOpts = {
    http: HttpClient
    /** undefined = the caller's own feed (/api/user/activity); set = one org's feed. */
    path: () => string
}

/**
 * Activity — a merged, time-sorted feed of recent deploys, publishes, and
 * key events. Read-only projection over state the backend already owns
 * (Activity() there has no write path of its own) — this leaf just parses
 * the wire shape.
 */
export function Activity(opts: ActivityOpts) {
    return {
        async list(): Promise<ActivityItem[]> {
            const raw = await opts.http.get<Record<string, unknown>>(opts.path())
            return rows(raw.items, "items").map(parseItem)
        },
    }
}

export type ActivityHandle = ReturnType<typeof Activity>

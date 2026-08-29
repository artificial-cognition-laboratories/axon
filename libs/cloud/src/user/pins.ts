import type { HttpClient } from "../platform/http"
import { record, rows, str } from "../platform/parse"

/**
 * A dashboard left-nav shortcut.
 *
 * `path` and `label` are stored server-side rather than resolved per render:
 * a pin is a route, so any /dashboard page with an :id is pinnable through
 * one mechanism and the nav needs no per-kind lookup to draw itself.
 */
export type Pin = {
    /** "agent" | "module" | "org" | … — open set; a new pinnable kind needs no client change. */
    kind: string
    /** Kind-scoped identifier: artifact id, org slug, etc. */
    refId: string
    label: string
    path: string
    pinnedAt: string
}

function parsePin(data: Record<string, unknown>): Pin {
    return {
        kind: str(data, "kind"),
        refId: str(data, "refId"),
        label: str(data, "label"),
        path: str(data, "path"),
        pinnedAt: str(data, "pinnedAt"),
    }
}

type PinsOpts = {
    http: HttpClient
}

export function Pins(opts: PinsOpts) {
    return {
        /** The caller's pins, newest first. */
        async list(): Promise<Pin[]> {
            const raw = record(await opts.http.get("/api/user/pins"), "pins response")
            return rows(raw.pins, "pins").map(parsePin)
        },

        /** Pin a page. Idempotent — re-pinning refreshes the label and path. */
        async add(input: { kind: string; refId: string; label: string; path: string }): Promise<Pin> {
            const raw = record(await opts.http.post("/api/user/pins", input), "pin response")
            return parsePin(record(raw.pin, "pin"))
        },

        /** Unpin. Idempotent — unpinning what isn't pinned succeeds. */
        async remove(kind: string, refId: string): Promise<void> {
            const params = new URLSearchParams({ kind, refId })
            await opts.http.delete(`/api/user/pins?${params}`)
        },
    }
}

export type PinsHandle = ReturnType<typeof Pins>

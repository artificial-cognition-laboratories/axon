import type { HttpClient } from "../platform/http"
import { bool, num, rows, str, strOrNull } from "../platform/parse"
import type { ArtifactKind } from "../registry/artifacts/types"

export type StarredItem = {
    kind: ArtifactKind
    id: string
    /** The full scoped name, "@axon/obsidian" — this item's public address. */
    name: string
    description: string | null
    private: boolean
    latestVersion: string | null
    starsCount: number
    starredAt: string
}

const STARRABLE_KINDS: readonly string[] = ["agent", "module", "cognet", "bench", "prompt", "extension"]

function parseStarredItem(data: Record<string, unknown>): StarredItem {
    const kind = str(data, "kind")
    // Every registry kind can be starred. This used to accept only agent and
    // module and THROW on anything else, so a single starred cognet took down
    // the whole starred page.
    if (!STARRABLE_KINDS.includes(kind)) {
        throw new Error(`invalid response: unknown starred kind "${kind}"`)
    }

    return {
        kind: kind as ArtifactKind,
        id: str(data, "id"),
        name: str(data, "name"),
        description: strOrNull(data, "description"),
        private: bool(data, "private"),
        latestVersion: strOrNull(data, "latestVersion"),
        starsCount: num(data, "starsCount"),
        starredAt: str(data, "starredAt"),
    }
}

type StarredOpts = {
    http: HttpClient
}

/** Everything the caller has starred, across agents and modules — most recently starred first. */
export function Starred(opts: StarredOpts) {
    return {
        async list(): Promise<StarredItem[]> {
            const raw = await opts.http.get<Record<string, unknown>>("/api/user/starred")
            return rows(raw.items, "items").map(parseStarredItem)
        },
    }
}

export type StarredHandle = ReturnType<typeof Starred>

import { err } from "@arcforge/err"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ModelCapability, ModelRecord } from "../types"
import { Sources } from "./sources"
import { Repositories, type RepoDetail } from "./repositories"

type CatalogOpts = {
    
    root?: string
    
    fetch?: typeof fetch
}
const SHAPE = 6

/** Cache registry queries and details without turning failures into empty results. */
export function Catalog(opts: CatalogOpts = {}) {
    const path = opts.root ?? join(homedir(), ".axon", "cache", "models-catalog.json")
    const doFetch = opts.fetch ?? fetch
    const sources = Sources({ fetch: doFetch })
    const repositories = Repositories({ fetch: doFetch })

    let cache: Record<string, ModelRecord[]> = {}

    let details: Record<string, RepoDetail> = {}

    let cursors: Record<string, (string | null)[]> = {}

    let times: Record<string, number> = {}
    let detailTimes: Record<string, number> = {}
    let hydrated = false
    function hydrate(): void {
        if (hydrated) return
        try {
            if (existsSync(path)) {
                const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
                    shape: number; queries?: Record<string, ModelRecord[]>; details?: Record<string, RepoDetail>;
                    cursors?: Record<string, (string | null)[]>; times?: Record<string, number>; detailTimes?: Record<string, number>
                }
                // Previous shapes describe different eligibility contracts.
                if (parsed.shape === SHAPE) {
                    cache = parsed.queries ?? {}
                    details = parsed.details ?? {}
                    cursors = parsed.cursors ?? {}
                    times = parsed.times ?? {}
                    detailTimes = parsed.detailTimes ?? {}
                }
            }
            hydrated = true
        } catch (cause) {
            throw err("MODEL_FETCH_FAILED", { detail: `model catalogue cache could not be read: ${path}`, cause: cause })
        }
    }

    function write(): void {
        try {
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, JSON.stringify({
                shape: SHAPE,
                fetchedAt: Date.now(),
                queries: cache,
                details: details,
                cursors: cursors,
                times: times,
                detailTimes: detailTimes,
            }), "utf-8")
        } catch (cause) {
            throw err("MODEL_FETCH_FAILED", { detail: `model catalogue cache could not be written: ${path}`, cause: cause })
        }
    }

    async function refreshDetail(specifier: string): Promise<RepoDetail> {
        hydrate()
        const fresh = await repositories.detail(specifier)
        details[specifier] = fresh
        detailTimes[specifier] = Date.now()
        write()
        return fresh
    }
    return {
        async detail(specifier: string): Promise<RepoDetail> {
            hydrate()
            const hit = details[specifier]
            const at = detailTimes[specifier]
            if (hit && at !== undefined && Date.now() - at < 6 * 60 * 60 * 1000) return hit
            return refreshDetail(specifier)
        },
        refreshDetail: refreshDetail,

        files: async (specifier: string) => (await repositories.detail(specifier)).files,

        get path(): string {
            return path
        },

        cached(query: string, capability?: ModelCapability, runnable = false): ModelRecord[] {
            hydrate()
            return cache[key(query, capability, runnable)] ?? []
        },

        stale(query: string, capability?: ModelCapability, runnable = false): boolean {
            hydrate()
            const at = times[key(query, capability, runnable)]
            return at === undefined || Date.now() - at >= 6 * 60 * 60 * 1000
        },
        refresh: refresh,

        more: more,

        hasMore: hasMore,
    }

    async function refresh(query: string, capability?: ModelCapability, runnable = false): Promise<ModelRecord[] | null> {
        hydrate()
        try {
            const found = await sources.search(query, capability, undefined, runnable)
            const k = key(query, capability, runnable)
            cursors[k] = found.cursors
            times[k] = Date.now()
            cache = { ...cache, [k]: found.models }
            write()
            return found.models
        } catch (cause) {
            throw err("MODEL_FETCH_FAILED", { detail: "model catalogue could not be refreshed", cause: cause })
        }
    }

    async function more(query: string, capability?: ModelCapability, runnable = false): Promise<ModelRecord[] | null> {
        hydrate()
        const k = key(query, capability, runnable)
        const carried = cursors[k]
        if (!carried || carried.every(cursor => cursor === null)) return null

        hydrate()
        try {
            const found = await sources.search(query, capability, carried, runnable)
            cursors[k] = found.cursors
            times[k] = Date.now()

            const existing = cache[k] ?? []
            const seen = new Set(existing.map(model => model.id))
            const appended = [...existing, ...found.models.filter(model => !seen.has(model.id))]

            cache = { ...cache, [k]: appended }
            write()
            return appended
        } catch (cause) {
            throw err("MODEL_FETCH_FAILED", { detail: "model catalogue continuation failed", cause: cause })
        }
    }

    function hasMore(query: string, capability?: ModelCapability, runnable = false): boolean {
        hydrate()
        const carried = cursors[key(query, capability, runnable)]
        return !!carried && carried.some(cursor => cursor !== null)
    }
}

export type CatalogT = ReturnType<typeof Catalog>

function key(query: string, capability?: ModelCapability, runnable = false): string {
    const normalised = query.trim().toLowerCase()
    const scoped = capability ? `${capability}:${normalised}` : normalised
    return runnable ? `runs:${scoped}` : scoped
}

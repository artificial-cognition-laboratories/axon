/**
 * Node built-ins are imported INSIDE the functions that use them, never at
 * module scope.
 *
 * This module is reachable from the browser: `@arcforge/cloud`'s model surface
 * is isomorphic, and the web app resolves engine roles the same way the CLI
 * does. A static `import ... from "node:fs/promises"` puts it in the browser's
 * module graph, where Vite replaces it with a stub that has no named exports —
 * and the page then dies with "doesn't provide an export named: 'readFile'".
 *
 * Deferring keeps the module isomorphic by construction: the disk cache is an
 * optimisation for processes that HAVE a disk, and a browser simply takes the
 * uncached path (see `hasDisk` below).
 */

/**
 * True where a filesystem cache is possible at all.
 *
 * The browser has no `process.versions.node`, so it skips read and write
 * entirely and fetches every time — which is correct: the catalogue is public,
 * the browser already has an HTTP cache, and there is no shared disk for the
 * per-machine cache this file exists to maintain.
 */
const hasDisk = typeof process !== "undefined" && process.versions?.node !== undefined

/**
 * The catalogue's on-disk cache.
 *
 * WHY THIS EXISTS. Model catalogues are PUBLIC, unauthenticated, and
 * byte-identical for every user — and every agent boot resolves its engine
 * roles against them before the capsule comes up. The in-memory cache above
 * this is per-process with a 5-minute TTL, so it never hits on the path that
 * matters: a fresh process per boot means a fresh cold fetch, measured at
 * ~271ms (204ms DNS + 33ms TLS + 33ms server) and accounting for half of a
 * 540ms boot. A fleet spawning ten agents paid it ten times, serially, ahead
 * of any useful work.
 *
 * Nothing here is user data and nothing is a secret, which is what makes a
 * shared file on disk the right shape rather than a per-agent copy.
 *
 * THAT PREMISE IS THE ENTRY CONDITION, not a property of this file. It holds
 * for the axon and openrouter catalogues and NOT for the merged one
 * (`/api/registry/models`), which attaches codex routes reflecting the
 * caller's own subscription entitlement — the backend marks that response
 * `Cache-Control: private` for exactly this reason. Caching it here made one
 * user's entitlement the machine's answer for every later caller, anonymous
 * ones included. The key is a catalogue NAME with no notion of who asked, so
 * a per-caller response cannot be stored here safely at all; `Models.all()`
 * opts out rather than this file learning about identity.
 */

/** Where the cache lives — one per machine, shared by every agent and the TUI. */
async function cacheDir(): Promise<string> {
    const { homedir } = await import("node:os")
    const path = await import("node:path")
    return path.join(process.env.AXON_HOME ?? path.join(homedir(), ".axon"), "cache", "registry")
}

/**
 * How long a cached catalogue is served without revalidating.
 *
 * Generous on purpose: a model catalogue changes when ArcLabs publishes a
 * model, which is a matter of weeks, and the cost of being an hour stale is
 * that a brand-new model is briefly unlistable. The cost of being wrong in
 * the other direction is a network round trip on every boot forever.
 */
const FRESH_MS = 60 * 60_000

/**
 * How long a STALE entry may still be served while a refresh runs behind it.
 *
 * This is the property that makes boot fast in the bad cases too: an offline
 * machine, a backend having a slow morning, a cold Cloud Run instance. Boot
 * reads disk and continues; the wire is never on the critical path once
 * anything has been cached at all.
 */
const STALE_MS = 30 * 24 * 60 * 60_000

type Entry<T> = {
    at: number
    /** Validator from the response, replayed as If-None-Match on revalidation. */
    etag?: string
    value: T
}

export type CacheRead<T> = {
    value: T
    /** True when this answer came off disk rather than the wire. */
    cached: boolean
}

/**
 * Read-through cache with stale-while-revalidate.
 *
 * Three outcomes, in the order they matter for boot latency:
 *   fresh  → return disk, touch nothing
 *   stale  → return disk NOW, refresh in the background
 *   absent → fetch, write, return
 *
 * A failed refresh is deliberately swallowed ONLY in the stale case, and
 * only because the caller already has a usable answer that it was handed
 * synchronously — the failure cannot be propagated to a caller that has
 * already returned. It is reported through `onError` so it is never silent.
 * In the absent case the error propagates: a caller with no answer must be
 * told, never handed an empty catalogue that looks like "you own no models".
 */
export function CatalogueStore(opts: { onError?: (cause: unknown) => void } = {}) {
    // A dropped background failure would be a silent degradation: the cache
    // quietly stops refreshing and the user runs on a month-old catalogue
    // with nothing anywhere saying so. Warning is the floor, not the design
    // — a caller with a session to commit to should pass onError.
    const report = opts.onError
        ?? ((cause: unknown) => console.warn(`[axon] model catalogue refresh failed: ${String(cause)}`))

    async function read<T>(key: string): Promise<Entry<T> | null> {
        if (!hasDisk) return null
        try {
            const { readFile } = await import("node:fs/promises")
            const path = await import("node:path")
            const raw = await readFile(path.join(await cacheDir(), `${key}.json`), "utf8")
            return JSON.parse(raw) as Entry<T>
        } catch {
            // A missing or corrupt cache file is not an error condition: it
            // is the cold case, and the only correct response is to fetch.
            return null
        }
    }

    async function write<T>(key: string, entry: Entry<T>): Promise<void> {
        if (!hasDisk) return
        const { mkdir, writeFile, rename } = await import("node:fs/promises")
        const path = await import("node:path")
        const dir = await cacheDir()
        await mkdir(dir, { recursive: true })
        // Written to a unique temp path then renamed, so a boot reading this
        // file concurrently sees either the old contents or the new ones and
        // never a half-written JSON document. Several agents booting at once
        // is the normal case for a fleet.
        const temp = path.join(dir, `${key}.${process.pid}.${Date.now()}.tmp`)
        await writeFile(temp, JSON.stringify(entry), "utf8")
        await rename(temp, path.join(dir, `${key}.json`))
    }

    return {
        async get<T>(key: string, load: (etag?: string) => Promise<{ value: T; etag?: string }>): Promise<CacheRead<T>> {
            const hit = await read<T>(key)
            const age = hit ? Date.now() - hit.at : Infinity

            if (hit && age < FRESH_MS) return { value: hit.value, cached: true }

            if (hit && age < STALE_MS) {
                // Serve now, refresh behind. The refresh is deliberately not
                // awaited — that is the whole point — so its failure has no
                // caller to reach and goes to onError instead of nowhere.
                void load(hit.etag)
                    .then(fresh => write(key, { at: Date.now(), value: fresh.value, ...(fresh.etag ? { etag: fresh.etag } : {}) }))
                    .catch(report)
                return { value: hit.value, cached: true }
            }

            const fresh = await load(hit?.etag)
            await write(key, { at: Date.now(), value: fresh.value, ...(fresh.etag ? { etag: fresh.etag } : {}) })
            return { value: fresh.value, cached: false }
        },
    }
}

export type CatalogueStoreT = ReturnType<typeof CatalogueStore>

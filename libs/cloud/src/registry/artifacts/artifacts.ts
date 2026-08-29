import type { HttpClient } from "../../platform/http"
import { record, rows, str } from "../../platform/parse"
import { Artifact, parseArtifactRecord } from "./artifact"
import type { ArtifactHandle } from "./artifact"
import { refine, type SearchInput } from "./search"
import type { ArtifactKind, ArtifactRecord, ResolvedArtifact } from "./types"

/** One page of catalog results, with the unpaginated total. */
export type ArtifactPage = {
    items: ArtifactRecord[]
    total: number
    page: number
    pageSize: number
}

/** Pagination guard: a backend ignoring `page` must not spin forever. */
const MAX_CATALOG_PAGES = 50

type ArtifactsOpts = {
    http: HttpClient
    runtime: "node" | "browser"
}

/**
 * The registry catalog — agents, modules, cognets, benches.
 *
 * `of(kind)` binds the kind for callers that know what they're publishing;
 * the unbound verbs search and resolve across every kind, which is how the
 * catalog is browsed as one thing and how `clone` fetches a name without
 * knowing what sits behind it.
 */
export function Artifacts(opts: ArtifactsOpts) {
    function artifact(id: string, kind?: ArtifactKind): ArtifactHandle {
        return Artifact({ id, http: opts.http, runtime: opts.runtime, ...(kind ? { kind } : {}) })
    }

    /** Register (idempotent — a known name returns the existing record). */
    async function create(input: {
        kind: ArtifactKind
        name: string
        description?: string
        private?: boolean
    }): Promise<ArtifactHandle> {
        const raw = record(await opts.http.post("/api/user/artifacts", input), "artifact")
        return artifact(str(raw, "artifactId"), input.kind)
    }

    /** The caller's own artifacts of one kind. Requires auth. */
    async function listOwned(kind: ArtifactKind): Promise<ArtifactRecord[]> {
        const raw = record(
            await opts.http.get(`/api/user/artifacts?kind=${kind}`),
            "owned artifacts",
        )
        return rows(raw.artifacts, "artifacts").map(parseArtifactRecord)
    }

    /**
     * Resolve a name to its latest (or pinned) version + download URL — the
     * install path, for any kind. The response carries `kind`, so a caller
     * that cares can check what it got.
     *
     * `abi` narrows an UNPINNED resolve to the newest version the caller's
     * kernel can actually load — the cognet install path passes the CLI's
     * KERNEL_ABI_VERSION so an incompatible bundle is never offered. Ignored
     * alongside an explicit version: a pin stays a pin.
     */
    async function resolve(name: string, version?: string, input?: { abi?: string }): Promise<ResolvedArtifact> {
        const params = new URLSearchParams({ name })
        if (version) params.set("version", version)
        if (input?.abi) params.set("abi", input.abi)

        const raw = record(await opts.http.get(`/api/registry/resolve?${params}`), "resolved artifact")
        return {
            artifactId: str(raw, "artifactId"),
            kind: str(raw, "kind") as ArtifactKind,
            name: str(raw, "name"),
            version: str(raw, "version"),
            downloadUrl: str(raw, "downloadUrl"),
        }
    }

    /**
     * A name (or id) → a handle, WITHOUT requiring a published version.
     *
     * Distinct from `resolve()`, which answers "which version do I install"
     * and 404s on an artifact that exists but has never published. This is the
     * routing lookup — what a page needs to turn "@cody/dave" in a URL into
     * something it can call verbs on, and what `create()` callers need
     * immediately, before any publish has happened.
     *
     * Kind-agnostic: the backend resolves against the shared namespace, so a
     * name is unambiguous without the caller knowing what sits behind it.
     */
    async function handle(nameOrId: string): Promise<ArtifactHandle> {
        const raw = record(
            await opts.http.get(`/api/registry/resolve-id?name=${encodeURIComponent(nameOrId)}`),
            "resolved artifact id",
        )
        // The route reports what it resolved, so the handle knows its kind
        // without the caller having said which they expected.
        return artifact(str(raw, "artifactId"), str(raw, "kind") as ArtifactKind)
    }

    /**
     * One page of the public catalog. Omit `kind` to search the whole
     * registry; pass one (or several) to narrow.
     *
     * Returns the page WITH its total, so a caller can tell a complete
     * result from a truncated one. Prefer `search()` unless you are
     * rendering a pager — a bare page read as the full catalogue is the
     * bug this shape exists to prevent.
     */
    async function searchPage(input?: {
        query?: string
        kind?: ArtifactKind | ArtifactKind[]
        page?: number
    }): Promise<ArtifactPage> {
        const params = new URLSearchParams()
        if (input?.query) params.set("q", input.query)
        if (input?.page) params.set("page", String(input.page))
        if (input?.kind) params.set("kind", Array.isArray(input.kind) ? input.kind.join(",") : input.kind)
        const suffix = params.size > 0 ? `?${params}` : ""

        const raw = record(await opts.http.get(`/api/registry/artifacts${suffix}`), "public artifacts")
        const items = rows(raw.artifacts, "artifacts").map(parseArtifactRecord)
        return {
            items,
            // An older backend sends neither field. Falling back to the page
            // length means such a response reports itself as complete, which
            // is the pre-existing behaviour rather than a silent empty page.
            total: typeof raw.total === "number" ? raw.total : items.length,
            page: typeof raw.page === "number" ? raw.page : (input?.page ?? 1),
            pageSize: typeof raw.pageSize === "number" ? raw.pageSize : items.length,
        }
    }

    /**
     * Every artifact matching the search, following pagination to the end.
     *
     * This is `search()` — the default — because it is what a catalogue
     * wants and what every caller already assumed it was getting. A single
     * page returning exactly PAGE_SIZE rows is indistinguishable from a
     * complete result, so consumers that fetched once and stopped silently
     * truncated; the web catalogue and the SEO routes both did, and both
     * looked correct until a kind crossed twenty.
     *
     * Reach for `searchPage()` only when rendering a pager, where the page
     * boundary is the point.
     */
    async function search(input?: SearchInput): Promise<ArtifactRecord[]> {
        const all: ArtifactRecord[] = []
        let page = 1
        // Bounded so a backend that ignores `page` (every request returning
        // page one) cannot spin forever — it stops once enough rows are in.
        while (page <= MAX_CATALOG_PAGES) {
            const result = await searchPage({
                ...(input?.query !== undefined ? { query: input.query } : {}),
                ...(input?.kind !== undefined ? { kind: input.kind } : {}),
                page,
            })
            all.push(...result.items)
            if (all.length >= result.total || result.items.length === 0) break
            page += 1
        }
        // Scope, sort and limit are applied over the COMPLETE set — see
        // refine(). Deliberately after the paging loop rather than inside it:
        // a limit that stopped the loop early would sort a prefix of the
        // catalogue and report it as the top of the whole thing.
        return input ? refine(all, input) : all
    }

    return {
        artifact: artifact,
        create: create,
        handle: handle,
        resolve: resolve,
        search: search,
        searchPage: searchPage,

        /** A kind-bound view — `registry.artifacts.of("cognet").create({ name })`. */
        of(kind: ArtifactKind) {
            return {
                kind,
                artifact: (id: string) => artifact(id, kind),
                create: (input: { name: string; description?: string; private?: boolean }) =>
                    create({ ...input, kind }),
                /** Name → handle, no published version required. See `handle()`. */
                handle: (nameOrId: string) => handle(nameOrId),
                /** Resolve, refusing a name that turned out to be another kind. */
                async resolve(name: string, version?: string, input?: { abi?: string }): Promise<ResolvedArtifact> {
                    const resolved = await resolve(name, version, input)
                    if (resolved.kind !== kind) {
                        throw new Error(`${name} is a ${resolved.kind}, not a ${kind}`)
                    }
                    return resolved
                },
                search: (input?: Omit<SearchInput, "kind">) => search({ ...input, kind }),
                searchPage: (input?: { query?: string; page?: number }) => searchPage({ ...input, kind }),
                /** The caller's own artifacts of this kind. */
                listOwned: () => listOwned(kind),
            }
        },
    }
}

export type ArtifactsHandle = ReturnType<typeof Artifacts>

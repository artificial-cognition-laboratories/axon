// Obsidian Local REST API client
// Plugin: https://github.com/coddingtonbear/obsidian-local-rest-api
// Default: https://127.0.0.1:27124 (HTTPS, self-signed cert)
//          http://127.0.0.1:27123  (HTTP, if enabled in plugin settings)

export type ClientConfig = {
    baseUrl: string
    apiKey: string
}

function config(): ClientConfig {
    const apiKey = process.env.OBSIDIAN_API_KEY
    if (!apiKey) throw new Error("OBSIDIAN_API_KEY is not set — required for Obsidian Local REST API")
    const baseUrl = (process.env.OBSIDIAN_BASE_URL ?? "http://127.0.0.1:27123").replace(/\/$/, "")
    return { baseUrl, apiKey }
}

async function request(method: string, path: string, opts: {
    body?: string
    headers?: Record<string, string>
    params?: Record<string, string>
} = {}): Promise<Response> {
    const { baseUrl, apiKey } = config()
    const url = new URL(`${baseUrl}${path}`)
    if (opts.params) {
        for (const [k, v] of Object.entries(opts.params)) url.searchParams.set(k, v)
    }

    const res = await fetch(url.toString(), {
        method,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "text/markdown",
            ...opts.headers,
        },
        body: opts.body,
    })

    if (!res.ok) {
        const text = await res.text().catch(() => "")
        let message = `Obsidian API error ${res.status}`
        try { message = JSON.parse(text).message ?? message } catch {}
        throw new Error(message)
    }

    return res
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type NoteMeta = {
    path: string
    content: string
    tags: string[]
    frontmatter: Record<string, unknown>
    stat: { ctime: number; mtime: number; size: number }
    links: string[]
    backlinks: string[]
}

export type SearchResult = {
    filename: string
    score: number
    matches: Array<{
        match: { start: number; end: number; source: string }
        context: string
    }>
}

export type TagCount = {
    name: string
    count: number
}

export type PatchOperation = "append" | "prepend" | "replace"
export type TargetType = "heading" | "block" | "frontmatter"

// ── API functions ──────────────────────────────────────────────────────────────

export async function readNote(path: string): Promise<NoteMeta> {
    const res = await request("GET", `/vault/${encodeNotePath(path)}`, {
        headers: { Accept: "application/vnd.olrapi.note+json" },
    })
    return res.json() as Promise<NoteMeta>
}

export async function readNoteContent(path: string): Promise<string> {
    const res = await request("GET", `/vault/${encodeNotePath(path)}`)
    return res.text()
}

export async function writeNote(path: string, content: string): Promise<void> {
    await request("PUT", `/vault/${encodeNotePath(path)}`, { body: content })
}

export async function appendToNote(path: string, content: string): Promise<void> {
    await request("POST", `/vault/${encodeNotePath(path)}`, { body: content })
}

export async function deleteNote(path: string): Promise<void> {
    await request("DELETE", `/vault/${encodeNotePath(path)}`)
}

export async function patchNote(path: string, opts: {
    targetType: TargetType
    target: string
    operation: PatchOperation
    content: string
    createIfMissing?: boolean
}): Promise<void> {
    await request("PATCH", `/vault/${encodeNotePath(path)}`, {
        body: opts.content,
        headers: {
            "Target-Type": opts.targetType,
            "Target": opts.target,
            "Operation": opts.operation,
            ...(opts.createIfMissing ? { "Create-Target-If-Missing": "true" } : {}),
        },
    })
}

export async function listVault(dir = ""): Promise<string[]> {
    const path = dir ? `/vault/${encodeNotePath(dir)}/` : "/vault/"
    const res = await request("GET", path, {
        headers: { Accept: "application/json" },
    })
    const body = await res.json() as { files: string[] }
    return body.files
}

export async function searchSimple(query: string, limit = 20): Promise<SearchResult[]> {
    const res = await request("POST", "/search/simple/", {
        params: { query },
        headers: { "Content-Type": "application/json" },
    })
    const results = await res.json() as SearchResult[]
    return results.slice(0, limit)
}

export async function searchJsonLogic(logic: unknown): Promise<NoteMeta[]> {
    const res = await request("POST", "/search/", {
        body: JSON.stringify(logic),
        headers: {
            "Content-Type": "application/vnd.olrapi.jsonlogic+json",
            Accept: "application/vnd.olrapi.note+json",
        },
    })
    return res.json() as Promise<NoteMeta[]>
}

export async function listTags(): Promise<TagCount[]> {
    const res = await request("GET", "/tags/")
    const body = await res.json() as { tags: TagCount[] }
    return body.tags
}

export async function getPeriodicNote(period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly"): Promise<NoteMeta> {
    const res = await request("GET", `/periodic/${period}/`, {
        headers: { Accept: "application/vnd.olrapi.note+json" },
    })
    return res.json() as Promise<NoteMeta>
}

export async function appendToPeriodicNote(period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly", content: string): Promise<void> {
    await request("POST", `/periodic/${period}/`, { body: content })
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Encode a vault-relative path for use in URL segments. Preserves slashes. */
function encodeNotePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/")
}

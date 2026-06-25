// arXiv Atom/XML API client
// Base: https://export.arxiv.org/api/query
// No auth required. Soft rate limit: ~3 req/s.

const BASE = "https://export.arxiv.org/api/query"

// ── XML helpers ───────────────────────────────────────────────────────────────

/** Extract text content of the first matching tag. */
function tag(xml: string, name: string): string {
    const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))
    return m ? m[1].replace(/<[^>]+>/g, "").trim() : ""
}

/** Extract all occurrences of a tag block. */
function tags(xml: string, name: string): string[] {
    const re = new RegExp(`<${name}[^>]*>[\\s\\S]*?</${name}>`, "gi")
    return xml.match(re) ?? []
}

// ── Response types (re-exported via tools file) ───────────────────────────────

export type Paper = {
    /** arXiv ID without version suffix, e.g. "1706.03762". */
    id: string
    /** Full versioned ID as returned by the API, e.g. "1706.03762v7". */
    versionedId: string
    title: string
    abstract: string
    authors: string[]
    /** Primary category, e.g. "cs.LG". */
    category: string
    /** All categories the paper is filed under. */
    categories: string[]
    /** ISO 8601 string — original submission date. */
    publishedAt: string
    /** ISO 8601 string — last update date. */
    updatedAt: string
    /** Direct link to abstract page. */
    url: string
    /** Direct link to PDF. */
    pdfUrl: string
    /** Journal reference if the paper has been published, otherwise null. */
    journalRef: string | null
    /** Author comment (often includes page count, venue, code link). */
    comment: string | null
}

// ── Entry parser ──────────────────────────────────────────────────────────────

function parseEntry(entry: string): Paper {
    // arXiv ID lives in the <id> tag as a URL: http://arxiv.org/abs/1706.03762v7
    const rawId = tag(entry, "id").replace(/.*\/abs\//, "")
    const versionedId = rawId
    const id = rawId.replace(/v\d+$/, "")

    const title = tag(entry, "title").replace(/\s+/g, " ")
    const abstract = tag(entry, "summary").replace(/\s+/g, " ")

    const authorBlocks = tags(entry, "author")
    const authors = authorBlocks.map(a => tag(a, "name"))

    // Primary category: <arxiv:primary_category term="cs.LG" .../>
    const primaryCat = (() => {
        const m = entry.match(/<arxiv:primary_category[^>]*\sterm="([^"]+)"/)
        return m ? (m[1] ?? "") : ""
    })()

    // All categories: <category term="cs.LG" .../>
    const categoryMatches = [...entry.matchAll(/<category[^>]*\sterm="([^"]+)"/g)]
    const categories = categoryMatches.map(m => m[1] ?? "")

    const publishedAt = tag(entry, "published")
    const updatedAt = tag(entry, "updated")

    // PDF link: <link title="pdf" href="..."/>
    const pdfMatch = entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/)
    const pdfUrl = pdfMatch ? (pdfMatch[1] ?? `https://arxiv.org/pdf/${id}`) : `https://arxiv.org/pdf/${id}`

    const url = `https://arxiv.org/abs/${id}`

    const journalRefRaw = tag(entry, "arxiv:journal_ref")
    const journalRef = journalRefRaw || null

    const commentRaw = tag(entry, "arxiv:comment")
    const comment = commentRaw || null

    return { id, versionedId, title, abstract, authors, category: primaryCat, categories, publishedAt, updatedAt, url, pdfUrl, journalRef, comment }
}

// ── Query builder ─────────────────────────────────────────────────────────────

export type QueryOptions = {
    /** Max results to return. Capped at 100 to stay within safe response size. Default: 10. */
    limit?: number
    /** Offset for pagination. Default: 0. */
    offset?: number
    /** Sort field. Default: "relevance". */
    sortBy?: "relevance" | "submittedDate" | "lastUpdatedDate"
    /** Sort direction. Default: "descending". */
    sortOrder?: "ascending" | "descending"
}

export async function queryArxiv(searchQuery: string, opts: QueryOptions = {}): Promise<{ papers: Paper[]; total: number }> {
    const limit = Math.min(opts.limit ?? 10, 100)
    const offset = opts.offset ?? 0
    const sortBy = opts.sortBy ?? "relevance"
    const sortOrder = opts.sortOrder ?? "descending"

    const params = new URLSearchParams({
        search_query: searchQuery,
        start: String(offset),
        max_results: String(limit),
        sortBy,
        sortOrder,
    })

    const res = await fetch(`${BASE}?${params}`)
    if (!res.ok) throw new Error(`arXiv API error: ${res.status} ${res.statusText}`)

    const xml = await res.text()

    const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/)
    const total = totalMatch ? parseInt(totalMatch[1] ?? "0", 10) : 0

    const entryBlocks = tags(xml, "entry")
    const papers = entryBlocks.map(parseEntry)

    return { papers, total }
}

export async function fetchByIds(ids: string[]): Promise<Paper[]> {
    if (ids.length === 0) return []

    const params = new URLSearchParams({
        id_list: ids.join(","),
        max_results: String(ids.length),
    })

    const res = await fetch(`${BASE}?${params}`)
    if (!res.ok) throw new Error(`arXiv API error: ${res.status} ${res.statusText}`)

    const xml = await res.text()
    const entryBlocks = tags(xml, "entry")
    return entryBlocks.map(parseEntry)
}

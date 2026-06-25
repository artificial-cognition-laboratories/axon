# @axon/arxiv

arXiv paper search and retrieval. Gives your agent a clean interface to 2M+ papers across CS, math, physics, stats, biology, and economics — no API key required.

## Install

```bash
axon install @axon/arxiv
axon prepare
```

No environment variables required.

## Tools

After `axon prepare`, tools are available on `axon.tools.arxiv.*`.

---

### `arxiv.search(query, opts?)`

Full Lucene query syntax. Use this when you need precise control.

```typescript
const { papers, total } = await arxiv.search("ti:\"attention is all you need\"")

const { papers } = await arxiv.search("au:LeCun AND cat:cs.LG", {
    sortBy: "submittedDate",
    limit: 20,
})
```

**Field prefixes:**

| Prefix | Searches |
|--------|----------|
| `ti:`  | Title |
| `au:`  | Author |
| `abs:` | Abstract |
| `cat:` | Category |
| `all:` | All fields (default) |

**Operators:** `AND`, `OR`, `NOT`. Multi-word phrases must be quoted: `ti:"graph neural networks"`.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | `10` | Max results (capped at 100) |
| `offset` | `number` | `0` | Pagination offset |
| `sortBy` | `"relevance" \| "submittedDate" \| "lastUpdatedDate"` | `"relevance"` | Sort field |
| `sortOrder` | `"ascending" \| "descending"` | `"descending"` | Sort direction |

**Returns:** `{ papers: Paper[], total: number }`

---

### `arxiv.get(id)`

Fetch a single paper by arXiv ID. Returns `null` if not found.

```typescript
const paper = await arxiv.get("1706.03762")
// → { id: "1706.03762", title: "Attention Is All You Need", ... }

const specific = await arxiv.get("1706.03762v3")  // exact version
```

**Returns:** `Paper | null`

---

### `arxiv.fetch(ids[])`

Batch fetch by arXiv ID. Most efficient when you already have IDs — up to 100 in a single request.

```typescript
const papers = await arxiv.fetch(["1706.03762", "2006.16189", "1512.03385"])
```

Accepts bare IDs (`"1706.03762"`) or versioned IDs (`"1706.03762v7"`).

**Returns:** `Paper[]`

---

### `arxiv.recent(category, limit?)`

Latest papers in a category, sorted by submission date.

```typescript
const papers = await arxiv.recent("cs.LG", 10)
const nlp = await arxiv.recent("cs.CL", 25)
```

**Common categories:**

| Category | Field |
|----------|-------|
| `cs.AI` | Artificial Intelligence |
| `cs.LG` | Machine Learning |
| `cs.CL` | Computation & Language (NLP) |
| `cs.CV` | Computer Vision |
| `cs.NE` | Neural & Evolutionary Computing |
| `cs.RO` | Robotics |
| `stat.ML` | Statistics / Machine Learning |
| `math.OC` | Optimization & Control |
| `q-bio.NC` | Neurons & Cognition |

**Returns:** `Paper[]`

---

### `arxiv.about(concept, opts?)`

Natural-language concept search across title and abstract. Handles Lucene quoting automatically.

```typescript
const papers = await arxiv.about("diffusion models", { category: "cs.CV", limit: 15 })
const papers = await arxiv.about("reinforcement learning from human feedback")
```

**Options:** `category?`, `limit?`, `offset?`

**Returns:** `Paper[]`

---

### `arxiv.byAuthor(name, opts?)`

Papers by an author, sorted by submission date. Use last name for broad results, full name for exact matching.

```typescript
const papers = await arxiv.byAuthor("Hinton", { limit: 20 })
const papers = await arxiv.byAuthor("Yann LeCun")  // quoted automatically
```

**Options:** `limit?`, `offset?`

**Returns:** `Paper[]`

---

### `arxiv.since(from, to, query?, opts?)`

Papers submitted within a date range, optionally filtered by a query.

```typescript
// All cs.AI papers in H1 2026
const papers = await arxiv.since("2026-01-01", "2026-06-30", "cat:cs.AI", { limit: 50 })

// Papers about transformers across any category in 2025
const papers = await arxiv.since("2025-01-01", "2025-12-31", "abs:transformer")
```

Dates are inclusive UTC boundaries in `YYYY-MM-DD` format.

**Returns:** `Paper[]`

---

## The `Paper` type

Every method returns `Paper` objects:

```typescript
type Paper = {
    id: string           // "1706.03762" — no version suffix
    versionedId: string  // "1706.03762v7" — as returned by the API
    title: string
    abstract: string
    authors: string[]
    category: string     // primary category, e.g. "cs.LG"
    categories: string[] // all categories
    publishedAt: string  // ISO 8601 — original submission
    updatedAt: string    // ISO 8601 — last revision
    url: string          // https://arxiv.org/abs/1706.03762
    pdfUrl: string       // https://arxiv.org/pdf/1706.03762
    journalRef: string | null  // set if the paper has been published
    comment: string | null     // author note — often has page count, venue, code link
}
```

## Rate limits

arXiv does not publish official rate limits. The practical ceiling is ~3 requests/second. The module makes no attempt to throttle — callers should introduce delays if issuing many consecutive requests in a loop.

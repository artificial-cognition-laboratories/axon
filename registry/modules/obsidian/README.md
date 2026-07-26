# @axon/obsidian

Obsidian vault integration. Read, write, search, and surgically patch notes — your agent gets full access to your vault without clobbering structure.

## Prerequisites

Install the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin in Obsidian, then enable it and copy the API key from Settings → Local REST API.

## Install

```bash
axon install @axon/obsidian
axon prepare
```

Add to your agent's `.env`:

```
OBSIDIAN_API_KEY=your-api-key-here

# Optional — defaults to http://127.0.0.1:27123
# Use https://127.0.0.1:27124 if HTTPS is enabled in the plugin
OBSIDIAN_BASE_URL=http://127.0.0.1:27123
```

## Tools

---

### `obsidian.read(path)`

Read a note with full metadata: content, tags, frontmatter, links, and backlinks.

```typescript
const note = await obsidian.read("Projects/my-note.md")
// → { path, content, tags, frontmatter, links, backlinks, stat }
```

**Returns:** `NoteMeta`

---

### `obsidian.content(path)`

Read just the markdown text of a note. Cheaper than `read()` when you don't need metadata.

```typescript
const md = await obsidian.content("Projects/my-note.md")
```

**Returns:** `string`

---

### `obsidian.write(path, content)`

Create or overwrite a note. Creates parent directories automatically.

```typescript
await obsidian.write("Projects/my-note.md", "# My Note\n\nHello.")
```

---

### `obsidian.append(path, content)`

Append content to the end of a note. Creates the note if it doesn't exist.

```typescript
await obsidian.append("Daily/2026-06-25.md", "\n## Evening\n\nWrapped up the module.")
```

---

### `obsidian.delete(path)`

Delete a note.

```typescript
await obsidian.delete("Drafts/scratch.md")
```

---

### `obsidian.patch(path, opts)`

Surgically edit a specific section without touching the rest of the note. Use this instead of `write()` whenever the note has existing structure worth preserving.

```typescript
// Append a task under the "## TODO" heading
await obsidian.patch("Projects/my-note.md", {
    targetType: "heading",
    target: "TODO",
    operation: "append",
    content: "- [ ] Review PR",
})

// Update a frontmatter field
await obsidian.patch("Projects/my-note.md", {
    targetType: "frontmatter",
    target: "status",
    operation: "replace",
    content: "done",
})

// Create the heading if it doesn't exist yet
await obsidian.patch("Projects/my-note.md", {
    targetType: "heading",
    target: "Notes",
    operation: "append",
    content: "First entry.",
    createIfMissing: true,
})
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `targetType` | `"heading" \| "frontmatter" \| "block"` | What to target |
| `target` | `string` | Heading text, frontmatter key, or block ref (e.g. `^ref1`) |
| `operation` | `"append" \| "prepend" \| "replace"` | What to do |
| `content` | `string` | Content to apply |
| `createIfMissing` | `boolean` | Create target if absent (default: false) |

---

### `obsidian.list(dir?)`

List files and directories at a vault path. Omit `dir` to list the vault root. Directories end with `/`.

```typescript
const root = await obsidian.list()
// → ["Daily/", "Projects/", "Archive/", "index.md"]

const files = await obsidian.list("Projects")
// → ["Projects/my-note.md", "Projects/archive/"]
```

**Returns:** `string[]`

---

### `obsidian.search(query, limit?)`

Full-text search across all notes. Returns scored results with surrounding context snippets.

```typescript
const results = await obsidian.search("attention mechanism transformer")
// → [{ filename, score, matches: [{ context: "...surrounding text..." }] }]
```

**Returns:** `SearchResult[]`

---

### `obsidian.find(logic)`

Structured search using [JsonLogic](https://jsonlogic.com/) against vault metadata. More powerful than `search()` when you need to filter by frontmatter, tags, or links.

Available fields: `path`, `content`, `frontmatter`, `tags`, `stat`, `links`, `backlinks`.
Custom operators: `glob(pattern, field)`, `regexp(pattern, field)`.

```typescript
// Notes with status "active" in the Projects folder
const notes = await obsidian.find({
    "and": [
        { "==": [{ "var": "frontmatter.status" }, "active"] },
        { "glob": ["Projects/*", { "var": "path" }] },
    ]
})

// Notes tagged #meeting
const notes = await obsidian.find({
    "in": ["meeting", { "var": "tags" }]
})

// Notes that link to a specific file
const notes = await obsidian.find({
    "in": ["Projects/my-note.md", { "var": "links" }]
})
```

**Returns:** `NoteMeta[]`

---

### `obsidian.tags()`

List all tags in the vault with usage counts.

```typescript
const tags = await obsidian.tags()
// → [{ name: "project/active", count: 5 }, { name: "todo", count: 12 }]
```

**Returns:** `TagCount[]`

---

### `obsidian.periodic(period)`

Get the current periodic note (daily, weekly, monthly, quarterly, or yearly). Requires the Periodic Notes plugin.

```typescript
const today = await obsidian.periodic("daily")
// → { path: "Daily/2026-06-25.md", content: "...", ... }
```

**Returns:** `NoteMeta`

---

### `obsidian.appendPeriodic(period, content)`

Append content to the current periodic note. Creates it if it doesn't exist.

```typescript
await obsidian.appendPeriodic("daily", "\n## Notes\n\nBuilt the obsidian module.")
```

---

## The `NoteMeta` type

```typescript
type NoteMeta = {
    path: string                        // vault-relative path
    content: string                     // full markdown content
    tags: string[]                      // e.g. ["project/active", "todo"]
    frontmatter: Record<string, unknown> // parsed YAML frontmatter
    stat: { ctime: number; mtime: number; size: number }
    links: string[]                     // paths this note links to
    backlinks: string[]                 // paths that link to this note
}
```

## Notes

- All paths are vault-relative: `"Projects/my-note.md"`, not absolute filesystem paths.
- The plugin must be running (Obsidian must be open) for any tool to work.
- HTTPS (`https://127.0.0.1:27124`) uses a self-signed certificate. If you get TLS errors, switch to HTTP (`http://127.0.0.1:27123`) by setting `OBSIDIAN_BASE_URL`.
- `periodic()` and `appendPeriodic()` require the [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) plugin.

import {
    readNote,
    readNoteContent,
    writeNote,
    appendToNote,
    deleteNote,
    patchNote,
    listVault,
    searchSimple,
    searchJsonLogic,
    listTags,
    getPeriodicNote,
    appendToPeriodicNote,
} from "../obsidian/client.js"

export type { NoteMeta, SearchResult, TagCount, PatchOperation, TargetType } from "../obsidian/client.js"

// ── Public surface ─────────────────────────────────────────────────────────────

export const obsidian = {
    /**
     * Read a note — returns full content plus metadata: tags, frontmatter,
     * links, backlinks, and file stat.
     *
     * Path is vault-relative, e.g. `"Projects/my-note.md"`.
     *
     * @example
     * const note = await obsidian.read("Projects/my-note.md")
     * // → { path, content, tags, frontmatter, links, backlinks, stat }
     */
    async read(path: string): Promise<import("../obsidian/client.js").NoteMeta> {
        return readNote(path)
    },

    /**
     * Read just the markdown content of a note, without metadata.
     * Cheaper than `read()` when you only need the text.
     *
     * @example
     * const md = await obsidian.content("Projects/my-note.md")
     */
    async content(path: string): Promise<string> {
        return readNoteContent(path)
    },

    /**
     * Create or overwrite a note. Creates parent directories automatically.
     *
     * @example
     * await obsidian.write("Projects/my-note.md", "# My Note\n\nHello.")
     */
    async write(path: string, content: string): Promise<void> {
        return writeNote(path, content)
    },

    /**
     * Append content to the end of a note. Creates the note if it doesn't exist.
     *
     * @example
     * await obsidian.append("Daily/2026-06-25.md", "\n## Evening\n\nWrapped up the module.")
     */
    async append(path: string, content: string): Promise<void> {
        return appendToNote(path, content)
    },

    /**
     * Delete a note.
     *
     * @example
     * await obsidian.delete("Drafts/scratch.md")
     */
    async delete(path: string): Promise<void> {
        return deleteNote(path)
    },

    /**
     * Surgically edit a specific section of a note without touching the rest.
     *
     * - `targetType: "heading"` — target a section by its heading text
     * - `targetType: "frontmatter"` — target a specific frontmatter field
     * - `targetType: "block"` — target a block reference (e.g. `^ref1`)
     *
     * Operations:
     * - `"append"` — add content after the target
     * - `"prepend"` — add content before the target
     * - `"replace"` — replace the target's content entirely
     *
     * Set `createIfMissing: true` to create the heading if it doesn't exist.
     *
     * @example
     * // Append a task under the "## TODO" heading
     * await obsidian.patch("Projects/my-note.md", {
     *     targetType: "heading",
     *     target: "TODO",
     *     operation: "append",
     *     content: "- [ ] Review PR",
     * })
     *
     * @example
     * // Update a frontmatter field
     * await obsidian.patch("Projects/my-note.md", {
     *     targetType: "frontmatter",
     *     target: "status",
     *     operation: "replace",
     *     content: "done",
     * })
     */
    async patch(path: string, opts: {
        targetType: import("../obsidian/client.js").TargetType
        target: string
        operation: import("../obsidian/client.js").PatchOperation
        content: string
        createIfMissing?: boolean
    }): Promise<void> {
        return patchNote(path, opts)
    },

    /**
     * List files and directories at a vault path. Omit path to list the vault root.
     *
     * Returns vault-relative paths. Directories end with `/`.
     *
     * @example
     * const files = await obsidian.list("Projects")
     * // → ["Projects/my-note.md", "Projects/archive/", ...]
     *
     * @example
     * const root = await obsidian.list()
     * // → ["Daily/", "Projects/", "Archive/", "index.md"]
     */
    async list(dir?: string): Promise<string[]> {
        return listVault(dir)
    },

    /**
     * Full-text search across all notes in the vault.
     *
     * Returns scored results with surrounding context snippets.
     * Use `find()` for structured queries against frontmatter or tags.
     *
     * @example
     * const results = await obsidian.search("attention mechanism transformer")
     * // → [{ filename, score, matches: [{ context: "...text..." }] }]
     */
    async search(query: string, limit = 20): Promise<import("../obsidian/client.js").SearchResult[]> {
        return searchSimple(query, limit)
    },

    /**
     * Structured search using JsonLogic expressions against vault metadata.
     *
     * More powerful than `search()` for metadata queries — filter by frontmatter
     * values, tags, links, backlinks, or file paths.
     *
     * Available fields: `path`, `content`, `frontmatter`, `tags`, `stat`, `links`, `backlinks`.
     * Custom operators: `glob(pattern, field)`, `regexp(pattern, field)`.
     *
     * @example
     * // Notes with status "active" in the Projects folder
     * const notes = await obsidian.find({
     *     "and": [
     *         { "==": [{ "var": "frontmatter.status" }, "active"] },
     *         { "glob": ["Projects/*", { "var": "path" }] },
     *     ]
     * })
     *
     * @example
     * // Notes tagged #meeting
     * const notes = await obsidian.find({
     *     "in": ["meeting", { "var": "tags" }]
     * })
     */
    async find(logic: unknown): Promise<import("../obsidian/client.js").NoteMeta[]> {
        return searchJsonLogic(logic)
    },

    /**
     * List all tags in the vault with their usage counts.
     *
     * @example
     * const tags = await obsidian.tags()
     * // → [{ name: "project/active", count: 5 }, { name: "todo", count: 12 }]
     */
    async tags(): Promise<import("../obsidian/client.js").TagCount[]> {
        return listTags()
    },

    /**
     * Get a periodic note (daily, weekly, monthly, quarterly, or yearly).
     * Returns the note for the current period.
     *
     * Requires the Periodic Notes plugin to be installed and configured in Obsidian.
     *
     * @example
     * const today = await obsidian.periodic("daily")
     * // → { path: "Daily/2026-06-25.md", content: "...", ... }
     */
    async periodic(period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly"): Promise<import("../obsidian/client.js").NoteMeta> {
        return getPeriodicNote(period)
    },

    /**
     * Append content to the current periodic note.
     * Creates the note if it doesn't exist.
     *
     * @example
     * await obsidian.appendPeriodic("daily", "\n## Notes\n\nBuilt the arxiv module.")
     */
    async appendPeriodic(period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly", content: string): Promise<void> {
        return appendToPeriodicNote(period, content)
    },
}

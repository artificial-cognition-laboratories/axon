import { readFile, writeFile, appendFile, access, rm, readdir, mkdir, rename, copyFile, stat as fsStat } from "node:fs/promises"
import { join as pathJoin, sep as pathSep } from "node:path"

// ─── Public types ─────────────────────────────────────────────────────────────

export type ReadOpts = { from?: number; to?: number }

export type Stat = { size: number; isDir: boolean; isFile: boolean; mtime: number }

export type QueryOpts = {
    pattern?: string
    glob?: string
    cwd?: string
    maxDepth?: number
    limit?: number
    context?: number
    regex?: boolean
    ignoreCase?: boolean
}

export type MatchLine = { line: number; text: string; isMatch: boolean }
export type QueryMatch = { path: string; lines?: MatchLine[] }
export type QueryResult = { matches: QueryMatch[]; truncated: boolean; total: number }

export type PatchOpts = { find: string; replace: string; all?: boolean }
export type PatchResult = { count: number }

export type EditOp =
    | { op: "replace";      find: string; replace: string; all?: boolean; occurrence?: number; exact?: boolean }
    | { op: "insertBefore"; find: string; content: string; occurrence?: number; exact?: boolean }
    | { op: "insertAfter";  find: string; content: string; occurrence?: number; exact?: boolean }
    | { op: "delete";       find: string; all?: boolean;   occurrence?: number; exact?: boolean }

export type EditOpError  = { kind: "not_found" | "ambiguous_match" | "invalid_operation"; message: string }
export type EditOpResult = { ok: boolean; count: number; error?: EditOpError }
export type EditResult   = { ok: boolean; ops: EditOpResult[] }

// ─── Activity ambient ─────────────────────────────────────────────────────────
// The Axon capsule installs globalThis.axon (write-only telemetry — declares
// renderable activities to the session UI). Absent outside the capsule, so
// this module stays a plain, unit-testable TypeScript module: every emission
// goes through this no-op-safe accessor.

type ActivityHandle = { done(data?: Record<string, unknown>): void }
type AxonAmbient = { activity(type: string, data?: Record<string, unknown>): ActivityHandle }

function activity(type: string, data?: Record<string, unknown>): ActivityHandle {
    return (globalThis as { axon?: AxonAmbient }).axon?.activity(type, data) ?? { done() {} }
}

/**
 * Hunk-scoped excerpts for the file:patch activity: the changed region
 * plus `context` unchanged lines either side, from both versions of the
 * file. Never the whole file — activity payloads stay bounded. The
 * renderer owns the actual diffing/presentation.
 */
function activityHunks(before: string, after: string, context = 2): { before: string; after: string } {
    const a = before.split("\n")
    const b = after.split("\n")

    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let endA = a.length - 1
    let endB = b.length - 1
    while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB-- }

    const from = Math.max(0, start - context)
    return {
        before: a.slice(from, Math.min(a.length, endA + 1 + context)).join("\n"),
        after: b.slice(from, Math.min(b.length, endB + 1 + context)).join("\n"),
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Count all occurrences of `find` in `text`. */
function countOccurrences(text: string, find: string): number {
    let count = 0
    let search = 0
    while (search <= text.length) {
        const i = text.indexOf(find, search)
        if (i === -1) break
        count++
        search = i + 1
    }
    return count
}

/** Find the index of the Nth occurrence of `find` in `text` (1-indexed). Returns -1 if not found. */
function nthIndex(text: string, find: string, nth: number): number {
    let found = 0
    let search = 0
    while (search <= text.length) {
        const i = text.indexOf(find, search)
        if (i === -1) break
        found++
        if (found === nth) return i
        search = i + 1
    }
    return -1
}

function applyOp(text: string, op: EditOp): { text: string; result: EditOpResult } {
    const find = op.find

    if (op.op === "replace" || op.op === "delete") {
        const replacement = op.op === "delete" ? "" : op.replace

        if (op.all) {
            const re = new RegExp(escapeRegex(find), "g")
            let c = 0
            const replaced = text.replace(re, () => { c++; return replacement })
            if (c === 0) return { text, result: { ok: false, count: 0, error: { kind: "not_found", message: `No occurrences of find string found` } } }
            return { text: replaced, result: { ok: true, count: c } }
        }

        const total = countOccurrences(text, find)
        if (total === 0) return { text, result: { ok: false, count: 0, error: { kind: "not_found", message: `Find string not found in file` } } }
        if (op.exact && total > 1) return { text, result: { ok: false, count: total, error: { kind: "ambiguous_match", message: `Expected exactly one match, found ${total}` } } }

        const nth = op.occurrence ?? 1
        const idx = nthIndex(text, find, nth)
        if (idx === -1) return { text, result: { ok: false, count: total, error: { kind: "not_found", message: `Find string found ${total} time(s) but occurrence ${nth} does not exist` } } }

        const out = text.slice(0, idx) + replacement + text.slice(idx + find.length)
        return { text: out, result: { ok: true, count: 1 } }
    }

    if (op.op === "insertBefore" || op.op === "insertAfter") {
        const total = countOccurrences(text, find)
        if (total === 0) return { text, result: { ok: false, count: 0, error: { kind: "not_found", message: `Find string not found in file` } } }
        if (op.exact && total > 1) return { text, result: { ok: false, count: total, error: { kind: "ambiguous_match", message: `Expected exactly one match, found ${total}` } } }

        const nth = op.occurrence ?? 1
        const idx = nthIndex(text, find, nth)
        if (idx === -1) return { text, result: { ok: false, count: total, error: { kind: "not_found", message: `Find string found ${total} time(s) but occurrence ${nth} does not exist` } } }

        const insertAt = op.op === "insertBefore" ? idx : idx + find.length
        const out = text.slice(0, insertAt) + op.content + text.slice(insertAt)
        return { text: out, result: { ok: true, count: 1 } }
    }

    return { text, result: { ok: false, count: 0, error: { kind: "invalid_operation", message: `Unknown op: ${(op as EditOp).op}` } } }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const fs = {
    /**
     * Search for files by name or content. The primary tool for codebase navigation.
     *
     * @param opts.pattern - Text or regex to search in file contents
     * @param opts.glob - Glob pattern for filename matching (e.g. "**\/*.ts", "*mode*")
     * @param opts.cwd - Root directory to search from (defaults to cwd)
     * @param opts.maxDepth - Max directory traversal depth
     * @param opts.limit - Max results to return (default 50)
     * @param opts.context - Lines of context around content matches (default 0)
     * @param opts.regex - Treat pattern as regex (default false — literal match)
     * @param opts.ignoreCase - Case insensitive matching (default true)
     * @returns matches with file paths and matching lines; truncated flag if limit hit
     *
     * @example
     * await fs.query({ pattern: "useMode", glob: "**\/*.ts", context: 2 })
     * @example
     * await fs.query({ glob: "**\/*.vue" }) // find files by name only
     */
    async query(opts: QueryOpts): Promise<QueryResult> {
        const act = activity("file:search", { query: opts.pattern ?? opts.glob ?? "*", ...(opts.cwd ? { scope: opts.cwd } : {}) })
        const cwd = opts.cwd ?? process.cwd()
        const limit = opts.limit ?? 50
        const context = opts.context ?? 0
        const ignoreCase = opts.ignoreCase ?? true

        const globPattern = opts.glob ?? "**/*"
        const bunGlob = new Bun.Glob(globPattern)
        const files: string[] = []

        for await (const match of bunGlob.scan({ cwd, dot: false })) {
            if (match.includes("node_modules/") || match.includes(".git/")) continue
            if (opts.maxDepth != null) {
                const depth = match.split(pathSep).length - 1
                if (depth > opts.maxDepth) continue
            }
            files.push(match)
        }

        if (!opts.pattern) {
            const sorted = files.sort()
            const truncated = sorted.length > limit
            act.done({ matches: sorted.length })
            return {
                matches: sorted.slice(0, limit).map(path => ({ path })),
                truncated,
                total: sorted.length,
            }
        }

        const re = opts.regex
            ? new RegExp(opts.pattern, ignoreCase ? "i" : "")
            : new RegExp(escapeRegex(opts.pattern), ignoreCase ? "i" : "")

        const matches: QueryMatch[] = []
        let total = 0

        for (const relPath of files) {
            const absPath = pathJoin(cwd, relPath)
            let content: string
            try {
                const s = await fsStat(absPath)
                if (!s.isFile() || s.size > 1_048_576) continue
                content = await readFile(absPath, "utf-8")
            } catch { continue }

            if (!re.test(content)) continue

            const fileLines = content.split("\n")
            const matchLineNums = new Set<number>()

            for (let i = 0; i < fileLines.length; i++) {
                if (re.test(fileLines[i] ?? "")) matchLineNums.add(i)
            }

            if (matchLineNums.size === 0) continue
            total++

            if (matches.length < limit) {
                const includeLines = new Set<number>()
                for (const ln of matchLineNums) {
                    for (let c = Math.max(0, ln - context); c <= Math.min(fileLines.length - 1, ln + context); c++) {
                        includeLines.add(c)
                    }
                }

                const sortedLines = [...includeLines].sort((a, b) => a - b)
                const lines: MatchLine[] = sortedLines.map(i => ({
                    line: i + 1,
                    text: fileLines[i] ?? "",
                    isMatch: matchLineNums.has(i),
                }))

                matches.push({ path: relPath, lines })
            }
        }

        act.done({ matches: total })
        return { matches, truncated: total > limit, total }
    },

    /**
     * Read a file. Optionally specify line range for large files.
     *
     * @param opts.from - Start line (1-indexed)
     * @param opts.to - End line (inclusive)
     *
     * @example
     * await fs.read("src/index.ts")
     * @example
     * await fs.read("big-file.ts", { from: 50, to: 80 })
     */
    async read(path: string, opts?: ReadOpts): Promise<string> {
        activity("file:read", { path, ...(opts?.from || opts?.to ? { range: [opts.from ?? 1, opts.to ?? -1] } : {}) }).done()
        const content = await readFile(path, "utf-8")
        if (!opts?.from && !opts?.to) return content
        const lines = content.split("\n")
        const from = Math.max(1, opts?.from ?? 1)
        const to = Math.min(lines.length, opts?.to ?? lines.length)
        return lines
            .slice(from - 1, to)
            .map((line, i) => `${from + i}: ${line}`)
            .join("\n")
    },

    /** Get file metadata: size, type, modification time. */
    async stat(path: string): Promise<Stat> {
        const s = await fsStat(path)
        return { size: s.size, isDir: s.isDirectory(), isFile: s.isFile(), mtime: s.mtimeMs }
    },

    /** Check if a file or directory exists. */
    async exists(path: string): Promise<boolean> {
        try { await access(path); return true } catch { return false }
    },

    /** List entries in a directory. For searching across the tree, use query() instead. */
    async list(path: string): Promise<string[]> {
        return readdir(path)
    },

    /** Write content to a file, creating or overwriting it. */
    async write(path: string, content: string): Promise<void> {
        const act = activity("file:write", { path })
        await writeFile(path, content, "utf-8")
        act.done({ bytes: Buffer.byteLength(content, "utf-8") })
    },

    /** Append content to the end of a file. */
    async append(path: string, content: string): Promise<void> {
        await appendFile(path, content, "utf-8")
    },

    /**
     * Find and replace text within a file without rewriting the whole thing.
     *
     * @param opts.find - Exact string to find
     * @param opts.replace - Replacement string
     * @param opts.all - Replace all occurrences (default false — first only)
     * @returns { count } — number of replacements made
     *
     * @example
     * await fs.patch("src/config.ts", { find: "port: 3000", replace: "port: 8080" })
     */
    async patch(path: string, opts: PatchOpts): Promise<PatchResult> {
        const act = activity("file:patch", { path })
        const content = await readFile(path, "utf-8")
        let count = 0
        let result: string

        if (opts.all) {
            const escaped = escapeRegex(opts.find)
            const re = new RegExp(escaped, "g")
            result = content.replace(re, () => { count++; return opts.replace })
        } else {
            const idx = content.indexOf(opts.find)
            if (idx === -1) return { count: 0 }
            result = content.slice(0, idx) + opts.replace + content.slice(idx + opts.find.length)
            count = 1
        }

        if (count > 0) await writeFile(path, result, "utf-8")
        act.done(count > 0 ? activityHunks(content, result) : {})
        return { count }
    },

    /**
     * Apply multiple targeted edits to a file atomically.
     * Ops run in order — each sees the result of the previous.
     * Never rewrites the whole file. Use for inserts, deletes, or multiple changes.
     *
     * Ops:
     *   replace      — replace the Nth occurrence of find
     *   insertBefore — insert content immediately before the Nth occurrence of find
     *   insertAfter  — insert content immediately after the Nth occurrence of find
     *   delete       — remove the Nth occurrence of find
     *
     * Options (per op):
     *   occurrence  — which match to target (default: 1). Ignored when all: true.
     *   all         — apply to every match (replace/delete only).
     *   exact       — fail with ambiguous_match if find matches more than once.
     *                 Use this when the anchor should be unique — safer for destructive ops.
     *
     * Each op result:
     *   ok      — whether the op succeeded
     *   count   — matches found (on failure) or changes made (on success)
     *   error   — present on failure: { kind, message }
     *             kind: "not_found" | "ambiguous_match" | "invalid_operation"
     *
     * @example
     * // Add an import and rename a function in one call
     * const r = await fs.edit("src/index.ts", [
     *   { op: "insertAfter",  find: "import { foo } from './foo'", content: "\nimport { bar } from './bar'" },
     *   { op: "replace",      find: "function oldName(", replace: "function newName(", exact: true },
     * ])
     * if (!r.ok) console.log(r.ops.filter(o => !o.ok))
     *
     * @example
     * // Delete a block and replace every TODO comment
     * await fs.edit("src/utils.ts", [
     *   { op: "delete",  find: "// deprecated\nfunction legacy() {}\n", exact: true },
     *   { op: "replace", find: "// TODO", replace: "// DONE", all: true },
     * ])
     */
    async edit(path: string, ops: EditOp[]): Promise<EditResult> {
        const act = activity("file:patch", { path })
        const before = await readFile(path, "utf-8")
        let content = before
        const results: EditOpResult[] = []
        for (const op of ops) {
            const { text, result } = applyOp(content, op)
            content = text
            results.push(result)
        }
        await writeFile(path, content, "utf-8")
        act.done(content !== before ? activityHunks(before, content) : {})
        return { ok: results.every(r => r.ok), ops: results }
    },

    /** Delete a file. */
    async remove(path: string): Promise<void> {
        await rm(path, { recursive: false })
    },

    /** Create a directory (recursive — creates parent dirs as needed). */
    async mkdir(path: string): Promise<void> {
        await mkdir(path, { recursive: true })
    },

    /** Move or rename a file. */
    async move(from: string, to: string): Promise<void> {
        await rename(from, to)
    },

    /** Copy a file. */
    async copy(from: string, to: string): Promise<void> {
        await copyFile(from, to)
    },
}

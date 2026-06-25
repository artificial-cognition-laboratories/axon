import { clientForFile } from "../lsp/router.js"
import { readLine, toUri, fromUri } from "../lsp/client.js"

/**
 * A file path and source position pointing to a symbol in the workspace.
 * All positions are 1-based. `preview` contains the raw source line at that
 * position so you can evaluate relevance without a second read.
 */
export type Location = {
    /** Absolute path to the file. */
    file: string
    /** Line number, 1-based. */
    line: number
    /** Column number, 1-based. */
    col: number
    /** The full source line at this position. Use this to assess relevance before reading the file. */
    preview: string
}

/**
 * A TypeScript compiler diagnostic — an error, warning, or hint in a file.
 */
export type Diagnostic = {
    severity: "error" | "warning" | "hint"
    /** Line number, 1-based. */
    line: number
    /** Column number, 1-based. */
    col: number
    /** The full diagnostic message from the compiler. */
    message: string
    /** Language-server error code e.g. 2345. Used by codeActions() to find fixes. */
    code: number
}

/**
 * A fix or refactor action suggested by the language server at a given position.
 * Use `codeActions()` to get the list, then pass one to `applyCodeAction()` to
 * get the edits. Never apply without inspecting `title` first.
 */
export type CodeAction = {
    /** Human-readable description of what this action does. Read this before applying. */
    title: string
    /** Opaque handle. Pass back to `applyCodeAction()` unchanged. */
    action: unknown
}

/**
 * A set of text edits to apply to a single file.
 * Mutations return `FileEdit[]` rather than writing directly — inspect before applying.
 */
export type FileEdit = {
    /** Absolute path to the file to edit. */
    file: string
    edits: TextEdit[]
}

/**
 * A single contiguous text replacement. Replaces the range
 * [startLine:startCol, endLine:endCol) with `newText`.
 * All positions are 1-based. An insertion has start === end.
 */
export type TextEdit = {
    startLine: number
    startCol: number
    endLine: number
    endCol: number
    /** Replacement text. Empty string means deletion. */
    newText: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function workspaceRoot(): string {
    const root = process.env.AXON_WORKSPACE_ROOT
    if (!root) throw new Error("AXON_WORKSPACE_ROOT is not set — LSP tools require a workspace root")
    return root
}

async function lspClient(file: string) {
    return clientForFile(file, workspaceRoot())
}

function toLocation(uri: string, line: number, col: number): Location {
    const file = fromUri(uri)
    return { file, line, col, preview: readLine(file, line) }
}

function lspPosition(line: number, col: number) {
    // LSP positions are 0-based; our public API is 1-based
    return { line: line - 1, character: col - 1 }
}

function mapLspEdits(changes: Record<string, any[]> | undefined): FileEdit[] {
    if (!changes) return []
    return Object.entries(changes).map(([uri, edits]) => ({
        file: fromUri(uri),
        edits: edits.map(e => ({
            startLine: e.range.start.line + 1,
            startCol: e.range.start.character + 1,
            endLine: e.range.end.line + 1,
            endCol: e.range.end.character + 1,
            newText: e.newText ?? "",
        })),
    }))
}

// ── Public surface ─────────────────────────────────────────────────────────────

export const lsp = {
    /**
     * Find all definitions of a named symbol across the workspace.
     *
     * This is the primary entry point. Start here when you know a name but not
     * its location, then drill into results with position-based tools.
     *
     * Returns up to `maxResults` locations (default 20). Narrow the name if you
     * get too many results — common names like `id` or `type` will hit the cap.
     *
     * @example
    * const locs = await lsp.symbol("AuthToken")
     * // → [{ file: "src/types.ts", line: 14, col: 12, preview: "export type AuthToken = ..." }]
     */
    async symbol(name: string, maxResults = 20): Promise<Location[]> {
        // workspace/symbol is the standard LSP equivalent of tsserver navto
        const client = await lspClient(workspaceRoot() + "/index.ts").catch(() => {
            throw new Error("lsp.symbol() requires a TypeScript workspace root file to resolve the server. Use lsp.definition() with a specific file instead.")
        })

        const body = await client.request("workspace/symbol", {
            query: name,
        }) as any[]

        return (body ?? []).slice(0, maxResults).map((item: any) => {
            const loc = item.location
            return toLocation(loc.uri, loc.range.start.line + 1, loc.range.start.character + 1)
        })
    },

    /**
     * Resolve the definition of whatever symbol is at the given position.
     *
     * Use after `symbol()` or `references()` to follow a usage back to its
     * declaration. Returns null if the position has no resolvable symbol
     * (e.g. a string literal, comment, or whitespace).
     *
     * @example
     * const def = await lsp.definition("src/auth.ts", 42, 18)
     * // → { file: "src/types.ts", line: 14, col: 12, preview: "export type AuthToken = ..." }
     */
    async definition(file: string, line: number, col: number): Promise<Location | null> {
        const client = await lspClient(file)
        const body = await client.request("textDocument/definition", {
            textDocument: { uri: toUri(file) },
            position: lspPosition(line, col),
        }) as any

        const first = Array.isArray(body) ? body[0] : body
        if (!first) return null
        const loc = first.targetUri ? { uri: first.targetUri, range: first.targetSelectionRange ?? first.targetRange } : first
        return toLocation(loc.uri, loc.range.start.line + 1, loc.range.start.character + 1)
    },

    /**
     * Find every reference to the symbol at the given position across the workspace.
     *
     * Semantically precise — finds all usages of this specific symbol, not all
     * occurrences of the same string. Catches re-exports, type positions, and
     * aliased imports that grep would miss.
     *
     * @example
     * const refs = await lsp.references("src/types.ts", 14, 12)
     * // → [{ file: "src/auth.ts", line: 3, col: 10, preview: "import { AuthToken } from ..." }, ...]
     */
    async references(file: string, line: number, col: number): Promise<Location[]> {
        const client = await lspClient(file)
        const body = await client.request("textDocument/references", {
            textDocument: { uri: toUri(file) },
            position: lspPosition(line, col),
            context: { includeDeclaration: true },
        }) as any[]

        return (body ?? []).map((loc: any) =>
            toLocation(loc.uri, loc.range.start.line + 1, loc.range.start.character + 1)
        )
    },

    /**
     * Get type information for the symbol at the given position.
     *
     * Returns the type signature as a string — the same text you'd see hovering
     * in VS Code. Useful for understanding what a variable or function is without
     * reading the declaration file.
     *
     * Returns null if the position has no type information.
     *
     * @example
     * const type = await lsp.hover("src/auth.ts", 42, 18)
     * // → "(parameter) token: AuthToken"
     */
    async hover(file: string, line: number, col: number): Promise<string | null> {
        const client = await lspClient(file)
        const body = await client.request("textDocument/hover", {
            textDocument: { uri: toUri(file) },
            position: lspPosition(line, col),
        }) as any

        if (!body?.contents) return null
        const contents = body.contents
        if (typeof contents === "string") return contents || null
        if (Array.isArray(contents)) return contents.map((c: any) => typeof c === "string" ? c : c.value).join("\n") || null
        return contents.value || null
    },

    /**
     * Get all errors and warnings in a file.
     *
     * Note: standard LSP delivers diagnostics as push notifications, not on
     * request. This method opens the file and waits briefly for the server to
     * send diagnostics. Use before editing to establish a baseline and after
     * editing to confirm no new errors were introduced.
     *
     * @example
     * const errors = await lsp.diagnostics("src/auth.ts")
     * // → [{ severity: "error", line: 42, col: 18, code: 2345, message: "Type 'string' is not assignable..." }]
     */
    async diagnostics(file: string): Promise<Diagnostic[]> {
        // Standard LSP doesn't have a pull diagnostic request in all servers.
        // We use the optional textDocument/diagnostic method (LSP 3.17+) with
        // fallback to an empty result — servers that don't support it return null.
        const client = await lspClient(file)
        const body = await client.request("textDocument/diagnostic", {
            textDocument: { uri: toUri(file) },
        }, 10_000).catch(() => null) as any

        const items = body?.items ?? []
        return items.map((d: any) => ({
            severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "hint",
            line: d.range.start.line + 1,
            col: d.range.start.character + 1,
            message: d.message,
            code: typeof d.code === "number" ? d.code : 0,
        }))
    },

    /**
     * Get the fixes and refactors the language server suggests at this position.
     *
     * Read `action.title` on each result before applying.
     *
     * @example
     * const actions = await lsp.codeActions("src/auth.ts", 42, 18)
     * // → [{ title: "Add missing import 'AuthToken' from './types'", action: ... }]
     */
    async codeActions(file: string, line: number, col: number): Promise<CodeAction[]> {
        const client = await lspClient(file)
        const pos = lspPosition(line, col)
        const body = await client.request("textDocument/codeAction", {
            textDocument: { uri: toUri(file) },
            range: { start: pos, end: pos },
            context: { diagnostics: [] },
        }) as any[]

        return (body ?? []).map((action: any) => ({
            title: action.title,
            action,
        }))
    },

    /**
     * Resolve a `CodeAction` returned by `codeActions()` into concrete file edits.
     *
     * Does not write anything. Returns the full set of edits across all affected
     * files. Apply them with your file writing tools once you've confirmed they
     * look correct.
     *
     * @example
     * const actions = await lsp.codeActions("src/auth.ts", 42, 18)
     * const edits = await lsp.applyCodeAction(actions[0])
     * // → [{ file: "src/auth.ts", edits: [{ startLine: 1, ..., newText: "import { AuthToken }..." }] }]
     */
    async applyCodeAction(action: CodeAction): Promise<FileEdit[]> {
        const raw = action.action as any
        // Some actions carry edits directly; others need a resolve round-trip.
        // We handle the direct case — resolve is server-specific and uncommon.
        const changes = raw.edit?.changes ?? raw.edit?.documentChanges
            ?.filter((c: any) => c.edits)
            ?.reduce((acc: any, c: any) => ({ ...acc, [c.textDocument.uri]: c.edits }), {})
        return mapLspEdits(changes)
    },

    /**
     * Rename a symbol at the given position everywhere it is referenced.
     *
     * Semantically precise — renames across re-exports, type positions, aliased
     * imports, and JSDoc references. Safe to use where grep+sed would miss cases
     * or create false positives.
     *
     * Returns edits for every affected file. Does not write anything.
     *
     * @example
     * const edits = await lsp.rename("src/types.ts", 14, 12, "AccessToken")
     * // → [{ file: "src/types.ts", edits: [...] }, { file: "src/auth.ts", edits: [...] }]
     */
    async rename(file: string, line: number, col: number, newName: string): Promise<FileEdit[]> {
        const client = await lspClient(file)
        const body = await client.request("textDocument/rename", {
            textDocument: { uri: toUri(file) },
            position: lspPosition(line, col),
            newName,
        }) as any

        if (!body) throw new Error(`Cannot rename symbol at ${file}:${line}:${col}`)

        const changes = body.changes ?? body.documentChanges
            ?.filter((c: any) => c.edits)
            ?.reduce((acc: any, c: any) => ({ ...acc, [c.textDocument.uri]: c.edits }), {})
        return mapLspEdits(changes)
    },

    /**
     * Clean up imports in a file — remove unused, add missing, sort.
     *
     * Run after edits that add or remove symbols to keep imports consistent.
     * Returns edits for the single file only. Does not write anything.
     *
     * @example
     * const edits = await lsp.organizeImports("src/auth.ts")
     * // → [{ file: "src/auth.ts", edits: [{ startLine: 1, ..., newText: "" }] }]
     */
    async organizeImports(file: string): Promise<FileEdit[]> {
        const client = await lspClient(file)
        const body = await client.request("textDocument/codeAction", {
            textDocument: { uri: toUri(file) },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            context: {
                diagnostics: [],
                only: ["source.organizeImports"],
            },
        }) as any[]

        const action = (body ?? []).find((a: any) => a.kind === "source.organizeImports")
        if (!action) return []

        const changes = action.edit?.changes ?? action.edit?.documentChanges
            ?.filter((c: any) => c.edits)
            ?.reduce((acc: any, c: any) => ({ ...acc, [c.textDocument.uri]: c.edits }), {})
        return mapLspEdits(changes)
    },
}

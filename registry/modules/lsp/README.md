# @axon/lsp

Language server integration for Axon agents. Gives your agent the same code intelligence a senior engineer has in their editor — hover types, go-to-definition, find references, rename, diagnostics, and code actions — across TypeScript, Python, Rust, Go, and C/C++.

The agent can navigate unfamiliar codebases semantically rather than with grep, understand types without reading declaration files, and make precise multi-file edits that grep+sed would get wrong.

---

## Install

```bash
axon install @axon/lsp
```

Then install the language server for each language you work in:

| Language | Install |
|---|---|
| TypeScript / JavaScript | `npm i -g typescript-language-server typescript` |
| Python | `pip install python-lsp-server` |
| Rust | `rustup component add rust-analyzer` |
| Go | `go install golang.org/x/tools/gopls@latest` |
| C / C++ | `apt install clangd` / `brew install llvm` |

Only install what you need. If a language server isn't on PATH, tools for that language throw a clear error with the install command — agent boot is not blocked.

---

## Tools

All tools are available under `lsp.*` after install.

### `lsp.symbol(name, maxResults?)`

Find all definitions of a named symbol across the workspace. Start here when you know a name but not where it lives.

```typescript
const locs = await lsp.symbol("AuthToken")
// → [{ file: "src/types.ts", line: 14, col: 12, preview: "export type AuthToken = ..." }]
```

Returns up to `maxResults` locations (default 20). Narrow the name if common names like `id` or `type` return too many results.

---

### `lsp.definition(file, line, col)`

Resolve the definition of the symbol at a position. Follows re-exports and type aliases that grep would miss.

```typescript
const def = await lsp.definition("src/auth.ts", 42, 18)
// → { file: "src/types.ts", line: 14, col: 12, preview: "export type AuthToken = ..." }
// → null if position has no resolvable symbol
```

---

### `lsp.references(file, line, col)`

Find every reference to the symbol at a position across the entire workspace. Semantically precise — finds aliased imports, re-exports, and type positions that textual search would miss.

```typescript
const refs = await lsp.references("src/types.ts", 14, 12)
// → [{ file: "src/auth.ts", line: 3, col: 10, preview: "import { AuthToken } from ..." }, ...]
```

---

### `lsp.hover(file, line, col)`

Get the type signature and documentation for the symbol at a position. The same text shown on hover in VS Code.

```typescript
const info = await lsp.hover("src/auth.ts", 42, 18)
// → "(parameter) token: AuthToken"
// → null if position has no type information
```

---

### `lsp.diagnostics(file)`

Get all errors and warnings in a file. Use before editing to establish a baseline, and after editing to confirm no new errors were introduced.

```typescript
const errors = await lsp.diagnostics("src/auth.ts")
// → [{ severity: "error", line: 42, col: 18, code: 2345, message: "Type 'string' is not assignable to type 'AuthToken'" }]
```

Requires LSP 3.17 pull diagnostics support. `typescript-language-server`, `rust-analyzer`, and `gopls` all support it. Returns empty for servers that don't.

---

### `lsp.codeActions(file, line, col)`

Get the fixes and refactors the language server suggests at a position. Read `action.title` on each result before deciding which to apply.

```typescript
const actions = await lsp.codeActions("src/auth.ts", 42, 18)
// → [{ title: "Add missing import 'AuthToken' from './types'", action: ... }]
```

---

### `lsp.applyCodeAction(action)`

Resolve a `CodeAction` from `codeActions()` into concrete file edits. Does not write anything — inspect the edits before applying with your file tools.

```typescript
const actions = await lsp.codeActions("src/auth.ts", 42, 18)
const edits = await lsp.applyCodeAction(actions[0])
// → [{ file: "src/auth.ts", edits: [{ startLine: 1, startCol: 1, endLine: 1, endCol: 1, newText: "import { AuthToken } from './types'\n" }] }]
```

---

### `lsp.rename(file, line, col, newName)`

Rename a symbol everywhere it is referenced across the workspace. Semantically precise — covers aliased imports, re-exports, JSDoc references, and type positions.

Returns edits for every affected file. Does not write anything.

```typescript
const edits = await lsp.rename("src/types.ts", 14, 12, "AccessToken")
// → [{ file: "src/types.ts", edits: [...] }, { file: "src/auth.ts", edits: [...] }]
```

---

### `lsp.organizeImports(file)`

Remove unused imports, add missing ones, and sort — for the given file only. Run after edits that add or remove symbols. Does not write anything.

```typescript
const edits = await lsp.organizeImports("src/auth.ts")
// → [{ file: "src/auth.ts", edits: [{ startLine: 1, ..., newText: "" }] }]
```

---

## Return types

All position values are **1-based** (line 1, column 1 is the first character of the file).

```typescript
type Location = {
    file: string    // absolute path
    line: number    // 1-based
    col: number     // 1-based
    preview: string // raw source line — assess relevance without reading the file
}

type Diagnostic = {
    severity: "error" | "warning" | "hint"
    line: number
    col: number
    message: string
    code: number    // language-server error code e.g. 2345
}

type CodeAction = {
    title: string   // read before applying
    action: unknown // opaque — pass to applyCodeAction() unchanged
}

type FileEdit = {
    file: string
    edits: TextEdit[]
}

type TextEdit = {
    startLine: number
    startCol: number
    endLine: number
    endCol: number
    newText: string // empty string = deletion
}
```

---

## How it works

Each language server is a separate process speaking [LSP](https://microsoft.github.io/language-server-protocol/) over stdio. Servers are booted lazily on first use and kept alive for the agent's lifetime — the first call to a given language takes a few seconds while the server indexes the workspace; subsequent calls are fast.

On agent shutdown, all server processes are cleanly terminated.

If a language server binary is not found on PATH, the tool throws immediately with a message like:

```
TypeScript language server not found on PATH.
Install with: npm i -g typescript-language-server typescript
```

Agent boot is never blocked by a missing language server.

---

## Supported languages

| Language | Server | Extensions |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server` | `.ts` `.tsx` `.js` `.jsx` `.mts` `.cts` `.mjs` `.cjs` |
| Python | `pylsp` | `.py` `.pyi` |
| Rust | `rust-analyzer` | `.rs` |
| Go | `gopls` | `.go` |
| C / C++ | `clangd` | `.c` `.cc` `.cpp` `.cxx` `.h` `.hh` `.hpp` |

Adding a language requires one entry in `src/lsp/servers.ts`. No other changes needed.

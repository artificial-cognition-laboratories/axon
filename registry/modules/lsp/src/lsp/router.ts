/**
 * Language server router.
 *
 * One LspClient per language, lazily booted on first use. Manages the LSP
 * initialize handshake, file-open notifications, and process lifecycle.
 *
 * Usage:
 *   const client = await router.clientForFile("/abs/path/to/file.ts")
 *   // client is ready — initialized, file is open
 */

import { execSync } from "node:child_process"
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs"
import { join } from "node:path"
import { createLspClient, toUri, fromUri, type LspClient } from "./client.js"
import { serverForFile, type ServerDef } from "./servers.js"

// Minimal client capabilities — just enough to unlock the features we use.
const CLIENT_CAPABILITIES = {
    textDocument: {
        hover:      { contentFormat: ["plaintext"] },
        definition: {},
        references: {},
        rename:     { prepareSupport: false },
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "source.organizeImports"] } } },
        synchronization: { didOpen: true },
        publishDiagnostics: {},
    },
    workspace: {
        applyEdit: false,
    },
}

type ActiveServer = {
    client: LspClient
    openFiles: Set<string>
}

const servers = new Map<string, ActiveServer>()  // keyed by server binary name

/** Get (or lazily boot) the LSP client for the given file. */
export async function clientForFile(filePath: string, workspaceRoot: string): Promise<LspClient> {
    const def = serverForFile(filePath)
    if (!def) {
        throw new Error(`No language server configured for file: ${filePath}`)
    }

    let active = servers.get(def.binary)
    if (!active) {
        active = await bootServer(def, workspaceRoot)
        servers.set(def.binary, active)
    }

    await ensureFileOpen(active, filePath)
    return active.client
}

/**
 * A client for a whole workspace rather than one file.
 *
 * Workspace-wide requests (`workspace/symbol`) are about the PROJECT, not about
 * any particular document — so the CALLER should not have to name a file to ask
 * one. Which document anchors the server is this function's business, not the
 * caller's (see the seeding below: tsserver does need one, just not a
 * caller-chosen one).
 *
 * `symbol()` used to reach these through `clientForFile(root + "/index.ts")`,
 * fabricating a path to pick a server by extension. That path does not exist in
 * any real agent, so `ensureFileOpen` threw "cannot read file" — and the caller
 * caught it with a bare `.catch()` that replaced the cause with a guess about
 * workspace roots. Two bugs compounding: a synthetic file that had to exist,
 * and a handler that hid why it didn't.
 *
 * `language` selects the server the same way an extension would, without
 * implying a document.
 */
export async function clientForWorkspace(language: string, workspaceRoot: string): Promise<LspClient> {
    const def = serverForFile(`x${language}`)
    if (!def) {
        throw new Error(`No language server configured for ${language} files`)
    }

    let active = servers.get(def.binary)
    if (!active) {
        active = await bootServer(def, workspaceRoot)
        servers.set(def.binary, active)
    }

    // tsserver builds its index per PROJECT, and it infers a project from the
    // documents it has been told about. A server that has been initialized but
    // never sent a `didOpen` has none, and answers `workspace/symbol` with
    // "No Project." rather than an empty result — a hard error for a question
    // that is legitimately about the whole workspace.
    //
    // So one real file is opened to anchor the project. Which one does not
    // matter: tsserver walks up from it to the nearest tsconfig and indexes
    // that whole program, so any file inside the workspace yields the same
    // index. Cheap, and only ever done once per server.
    if (active.openFiles.size === 0) {
        const seed = findSourceFile(workspaceRoot, def.extensions)
        if (seed) await ensureFileOpen(active, seed)
    }

    return active.client
}

/**
 * Any source file the given server handles, breadth-first from the root.
 *
 * Breadth-first so a shallow file wins: a project's own `src/` sits near the
 * top while `node_modules` is both deeper and skipped, which keeps this from
 * walking a large tree to find something that was two levels down.
 *
 * Returns null when the workspace holds no matching source at all — a real
 * state (an empty agent, a repo of another language), and one the caller
 * reports honestly rather than failing over.
 */
function findSourceFile(root: string, extensions: string[]): string | null {
    const skip = new Set(["node_modules", ".git", "dist", ".output", ".agent", ".module"])
    const queue: string[] = [root]

    while (queue.length > 0) {
        const dir = queue.shift()!
        let entries: Dirent[]
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            continue // unreadable directory is not a failure — try the next
        }

        const dirs: string[] = []
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!skip.has(entry.name) && !entry.name.startsWith(".")) dirs.push(join(dir, entry.name))
                continue
            }
            const dot = entry.name.lastIndexOf(".")
            if (dot === -1) continue
            if (extensions.includes(entry.name.slice(dot).toLowerCase())) return join(dir, entry.name)
        }
        queue.push(...dirs)
    }

    return null
}

/** Shut down all running language servers. Called on agent shutdown. */
export function shutdownAll(): void {
    for (const [, active] of servers) {
        active.client.shutdown()
    }
    servers.clear()
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function bootServer(def: ServerDef, workspaceRoot: string): Promise<ActiveServer> {
    const binary = resolveBinary(def)  // throws with install hint if not found

    const client = createLspClient(binary, def.args, workspaceRoot)

    // LSP initialize handshake — required before any requests
    try {
        await client.request("initialize", {
            processId: process.pid,
            rootUri: toUri(workspaceRoot),
            capabilities: CLIENT_CAPABILITIES,
            initializationOptions: {
                ...(def.initializationOptions ?? {}),
                ...tsserverFallback(def, workspaceRoot),
            },
        })
    } catch (cause) {
        client.shutdown()
        // The server's own message names the problem ("Could not find a valid
        // TypeScript installation") but not the workspace it looked in or what
        // to do about it — and it is the single most likely way this fails, on
        // a machine where everything is installed correctly except the one
        // thing the server insists must be local.
        const reason = cause instanceof Error ? cause.message : String(cause)
        if (reason.includes("valid TypeScript installation")) {
            throw new Error(
                `${def.name} language server could not find a TypeScript installation for ${workspaceRoot}.\n`
                + `It resolves TypeScript from the workspace being analysed, so the project needs its own copy:\n`
                + `  cd ${workspaceRoot} && npm i -D typescript\n`
                + `(Analysing a project with the version IT declares is deliberate — a different one would `
                + `report errors the project's own compiler does not.)`,
            )
        }
        throw new Error(`${def.name} language server failed to start in ${workspaceRoot}: ${reason}`)
    }

    client.notify("initialized", {})

    return { client, openFiles: new Set() }
}

async function ensureFileOpen(active: ActiveServer, filePath: string): Promise<void> {
    if (active.openFiles.has(filePath)) return

    let text: string
    try {
        text = readFileSync(filePath, "utf-8")
    } catch {
        throw new Error(`LSP: cannot read file: ${filePath}`)
    }

    active.client.notify("textDocument/didOpen", {
        textDocument: {
            uri: toUri(filePath),
            languageId: languageId(filePath),
            version: 1,
            text,
        },
    })

    active.openFiles.add(filePath)
}

/**
 * A `tsserver.fallbackPath` for typescript-language-server, when one is needed.
 *
 * The server resolves TypeScript in a fixed order: an explicit `tsserver.path`,
 * then the WORKSPACE's own `node_modules/typescript`, then this fallback, then
 * a copy bundled with the server. It refuses to start when all four miss —
 * which is what a user analysing a repo with no local TypeScript sees.
 *
 * The workspace copy deliberately still wins. The agent is analysing SOMEONE
 * ELSE'S code, and typechecking it against a version they did not choose would
 * report errors their own `tsc` does not and miss ones it does — a diagnostics
 * tool that disagrees with the project's own compiler is worse than one that
 * says it cannot run.
 *
 * So this only fills the gap: a TypeScript reachable from this process, offered
 * as the LAST resort before failing. Returns nothing when there is none, so the
 * server's own error still surfaces and `describeMissingTypeScript` can explain
 * it.
 */
function tsserverFallback(def: ServerDef, workspaceRoot: string): Record<string, unknown> {
    if (def.binary !== "typescript-language-server") return {}
    // Already satisfied by the workspace — say nothing rather than offer an
    // alternative the server would ignore anyway.
    if (findTsserver([workspaceRoot])) return {}

    // Anywhere a TypeScript might live for THIS process: the module's own
    // resolution, and the usual global install roots.
    const candidates = [
        process.cwd(),
        process.env.AXON_HOME ?? "",
        process.env.HOME ?? "",
        "/usr/local",
        "/usr",
    ].filter(Boolean)

    const found = findTsserver(candidates)
    return found ? { tsserver: { fallbackPath: found } } : {}
}

/**
 * The first real `tsserver.js` under any of `roots`.
 *
 * `tsserver.js` specifically, not the package: TypeScript 7 ships `tsc` without
 * it, so a directory holding `typescript/` is not evidence the language server
 * can use it — checking the package alone offers a path the server then
 * rejects.
 */
function findTsserver(roots: string[]): string | null {
    for (const root of roots) {
        const candidate = join(root, "node_modules", "typescript", "lib", "tsserver.js")
        try {
            if (statSync(candidate).isFile()) return candidate
        } catch {
            // Not there. The next root is the whole recovery.
        }
    }
    return null
}

function resolveBinary(def: ServerDef): string {
    try {
        execSync(`which ${def.binary}`, { stdio: "ignore" })
        return def.binary
    } catch {
        throw new Error(
            `${def.name} language server not found on PATH.\n` +
            `Install with: ${def.installHint}`
        )
    }
}

function languageId(filePath: string): string {
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
    const map: Record<string, string> = {
        ".ts": "typescript", ".tsx": "typescriptreact",
        ".js": "javascript", ".jsx": "javascriptreact",
        ".mts": "typescript", ".cts": "typescript",
        ".mjs": "javascript", ".cjs": "javascript",
        ".py": "python", ".pyi": "python",
        ".rs": "rust",
        ".go": "go",
        ".c": "c", ".h": "c",
        ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hh": "cpp", ".hpp": "cpp",
    }
    return map[ext] ?? "plaintext"
}

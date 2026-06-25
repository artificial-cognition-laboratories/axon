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
import { readFileSync } from "node:fs"
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
    await client.request("initialize", {
        processId: process.pid,
        rootUri: toUri(workspaceRoot),
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: def.initializationOptions ?? {},
    })

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

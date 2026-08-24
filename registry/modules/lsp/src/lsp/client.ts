/**
 * Standard LSP JSON-RPC 2.0 client over stdio.
 *
 * Speaks the wire format used by typescript-language-server, rust-analyzer,
 * gopls, pylsp, clangd, and every other conformant language server.
 *
 * Protocol:
 *   Input  (us → server): Content-Length: N\r\n\r\n{json}
 *   Output (server → us): Content-Length: N\r\n\r\n{json}
 *
 * Requests have an `id`. Responses carry the matching `id`. Notifications and
 * server-push events have no `id`; `textDocument/publishDiagnostics` is
 * captured (it is the ONLY way a TypeScript server reports errors — the pull
 * request is optional and typescript-language-server does not implement it),
 * and the rest are ignored.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"

type JsonRpcRequest = {
    jsonrpc: "2.0"
    id: number
    method: string
    params?: unknown
}

type JsonRpcResponse = {
    jsonrpc: "2.0"
    id?: number
    result?: unknown
    error?: { code: number; message: string; data?: unknown }
}

type PendingRequest = {
    resolve: (result: unknown) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
}

export type LspClient = {
    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
    notify(method: string, params?: unknown): void
    /**
     * The most recent diagnostics the server PUSHED for a document.
     *
     * Servers publish diagnostics asynchronously after a document opens or
     * changes, rather than answering a request for them — so this is a
     * snapshot of what has arrived, not a query. `waitForDiagnostics` is what
     * callers use when they need the first batch to have landed.
     */
    diagnosticsFor(uri: string): unknown[]
    /**
     * Resolve once diagnostics have arrived for a document, or after
     * `timeoutMs`.
     *
     * A timeout is a legitimate answer, not a failure: a file with no problems
     * gets an empty publish from most servers but nothing at all from some, and
     * "no diagnostics" and "none yet" are indistinguishable from outside.
     * Waiting briefly and reporting what arrived is the honest reading.
     */
    waitForDiagnostics(uri: string, timeoutMs?: number): Promise<unknown[]>
    shutdown(): void
}

export function createLspClient(binary: string, args: string[], cwd: string): LspClient {
    const proc: ChildProcess = spawn(binary, args, {
        stdio: ["pipe", "pipe", "ignore"],
        cwd,
    })

    let nextId = 1
    const pending = new Map<number, PendingRequest>()
    /** uri → the latest diagnostics pushed for it. */
    const diagnostics = new Map<string, unknown[]>()
    /** uri → callbacks waiting for its first publish. */
    const diagnosticWaiters = new Map<string, Array<() => void>>()

    // ── Incoming message parser ───────────────────────────────────────────────
    // Messages arrive as: "Content-Length: N\r\n\r\n{json}"
    // We buffer raw bytes and extract complete messages.

    let buf = ""

    proc.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf-8")

        while (true) {
            const headerEnd = buf.indexOf("\r\n\r\n")
            if (headerEnd === -1) break

            const header = buf.slice(0, headerEnd)
            const match = header.match(/Content-Length:\s*(\d+)/i)
            if (!match) { buf = buf.slice(headerEnd + 4); continue }

            const length = parseInt(match[1], 10)
            const bodyStart = headerEnd + 4
            if (buf.length < bodyStart + length) break

            const body = buf.slice(bodyStart, bodyStart + length)
            buf = buf.slice(bodyStart + length)

            let msg: JsonRpcResponse
            try { msg = JSON.parse(body) } catch { continue }

            if (msg.id !== undefined) {
                const p = pending.get(msg.id)
                if (!p) continue
                clearTimeout(p.timer)
                pending.delete(msg.id)
                if (msg.error) {
                    p.reject(new Error(`LSP ${msg.error.message} (code ${msg.error.code})`))
                } else {
                    p.resolve(msg.result ?? null)
                }
                continue
            }

            // A notification (no id). Most are noise — progress, logs — but
            // `textDocument/publishDiagnostics` is how every TypeScript server
            // reports errors, so ignoring all of them meant `lsp.diagnostics()`
            // could only ever return [].
            //
            // The pull request it tried instead (`textDocument/diagnostic`,
            // LSP 3.17) is OPTIONAL and typescript-language-server does not
            // implement it — it answers `Unhandled method` — so the tool was
            // silently empty on every file, for every user, including files
            // with real type errors.
            const note = msg as unknown as { method?: string; params?: unknown }
            if (note.method === "textDocument/publishDiagnostics") {
                const params = note.params as { uri?: string; diagnostics?: unknown[] } | undefined
                if (params?.uri) {
                    diagnostics.set(params.uri, params.diagnostics ?? [])
                    for (const wake of diagnosticWaiters.get(params.uri) ?? []) wake()
                    diagnosticWaiters.delete(params.uri)
                }
            }
        }
    })

    proc.on("exit", () => {
        for (const [, p] of pending) {
            clearTimeout(p.timer)
            p.reject(new Error("LSP server process exited"))
        }
        pending.clear()
    })

    // ── Outgoing ──────────────────────────────────────────────────────────────

    function send(msg: JsonRpcRequest | { jsonrpc: "2.0"; method: string; params?: unknown }): void {
        const body = JSON.stringify(msg)
        const frame = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`
        proc.stdin!.write(frame)
    }

    function notify(method: string, params?: unknown): void {
        send({ jsonrpc: "2.0", method, params })
    }

    function request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
        const id = nextId++
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id)
                reject(new Error(`LSP ${method} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            pending.set(id, { resolve, reject, timer })
            send({ jsonrpc: "2.0", id, method, params })
        })
    }

    return {
        request,
        notify,

        diagnosticsFor(uri: string): unknown[] {
            return diagnostics.get(uri) ?? []
        },

        waitForDiagnostics(uri: string, timeoutMs = 3_000): Promise<unknown[]> {
            // Already arrived — a document opened earlier in the session.
            const have = diagnostics.get(uri)
            if (have) return Promise.resolve(have)

            return new Promise(resolve => {
                const done = () => {
                    clearTimeout(timer)
                    resolve(diagnostics.get(uri) ?? [])
                }
                const timer = setTimeout(done, timeoutMs)
                const waiters = diagnosticWaiters.get(uri) ?? []
                waiters.push(done)
                diagnosticWaiters.set(uri, waiters)
            })
        },

        shutdown() {
            try { proc.stdin!.end() } catch { /* ignore */ }
            try { proc.kill() } catch { /* ignore */ }
        },
    }
}

/** Read a specific 1-based line from a file for preview text. */
export function readLine(filePath: string, line: number): string {
    try {
        const lines = readFileSync(filePath, "utf-8").split("\n")
        return (lines[line - 1] ?? "").trim()
    } catch {
        return ""
    }
}

/** Convert an absolute file path to a file URI. */
export function toUri(filePath: string): string {
    return "file://" + filePath
}

/** Convert a file URI back to an absolute path. */
export function fromUri(uri: string): string {
    return uri.replace(/^file:\/\//, "")
}

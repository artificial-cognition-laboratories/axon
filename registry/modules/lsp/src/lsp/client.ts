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
 * Requests have an `id`. Responses carry the matching `id`. Notifications
 * and server-push events have no `id` and are ignored (we use request/response
 * only — no async diagnostics push).
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
    shutdown(): void
}

export function createLspClient(binary: string, args: string[], cwd: string): LspClient {
    const proc: ChildProcess = spawn(binary, args, {
        stdio: ["pipe", "pipe", "ignore"],
        cwd,
    })

    let nextId = 1
    const pending = new Map<number, PendingRequest>()

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
            }
            // Notifications (no id) are intentionally ignored
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

import { Http } from "./http"
import { Models } from "./models"
import type { OllamaStatus } from "./types"
import { err, isAxonError } from "@arcforge/err"

/** One Ollama endpoint's health and installed models. */
export function Daemon(opts: { host: string }) {
    const http = Http({ host: opts.host })
    const models = Models({ http: http })
    async function status(): Promise<OllamaStatus> {
        try {
            const version = await http.json<unknown>("/api/version")
            if (!version || typeof version !== "object" || !("version" in version) || typeof version.version !== "string") {
                throw err("OLLAMA_REQUEST_FAILED", { detail: "Invalid Ollama version response", context: { host: http.host } })
            }
            return { running: true, version: version.version }
        } catch (cause) {
            if (!isAxonError(cause) || cause.code !== "AX-TUI-037") throw cause
            return { running: false, reason: cause instanceof Error ? cause.message : String(cause) }
        }
    }
    return { host: http.host, models: models, status: status }
}

import { request as httpRequest } from "node:http"
import type { IncomingMessage } from "node:http"
import { err } from "@arcforge/err"
import type { AxonEngineRawEvent } from "@arcforge/types"

/** Read and validate the daemon's conversational inference stream. */
export function Receiver(opts: { socket: string }) {
    async function* stream(input: unknown, signal?: AbortSignal): AsyncGenerator<AxonEngineRawEvent> {
        signal?.throwIfAborted()
        const controller = new AbortController()
        const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
        const body = JSON.stringify({ path: ["models", "stream"], arg: input })
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const request = httpRequest({ socketPath: opts.socket, path: "/", method: "POST", signal: abort,
                headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, resolve)
            request.on("error", reject)
            request.end(body)
        })
        try {
            if (response.headers["content-type"] !== "application/x-ndjson") {
                let text = ""
                for await (const chunk of response) text += chunk.toString()
                throw err("MODEL_RUN_FAILED", { detail: `daemon does not support conversational streaming: ${text}` })
            }
            response.setEncoding("utf8")
            let pending = ""
            let done = false
            for await (const chunk of response) {
                pending += chunk
                let newline: number
                while ((newline = pending.indexOf("\n")) >= 0) {
                    const frame: unknown = JSON.parse(pending.slice(0, newline))
                    pending = pending.slice(newline + 1)
                    if (!frame || typeof frame !== "object") throw err("MODEL_RUN_FAILED", { detail: "invalid daemon stream frame" })
                    if ("error" in frame) throw err("MODEL_RUN_FAILED", { detail: String(frame.error) })
                    if ("end" in frame && frame.end === true) {
                        if (!done) throw err("MODEL_RUN_FAILED", { detail: "daemon stream ended without a response" })
                        return
                    }
                    if (!("value" in frame) || !isEvent(frame.value) || done) throw err("MODEL_RUN_FAILED", { detail: "invalid daemon inference event" })
                    done = frame.value.type === "done"
                    yield frame.value
                }
            }
            throw err("MODEL_RUN_FAILED", { detail: "daemon inference stream disconnected before completion" })
        } finally {
            controller.abort()
            response.destroy()
        }
    }
    return { stream: stream }
}

function isEvent(value: unknown): value is AxonEngineRawEvent {
    if (!value || typeof value !== "object" || !("type" in value)) return false
    if (value.type === "text:delta" || value.type === "thinking:delta") return "content" in value && typeof value.content === "string"
    if (value.type !== "done" || !("response" in value)) return false
    const response = value.response
    if (!response || typeof response !== "object" || !("text" in response) || typeof response.text !== "string"
        || !("stopReason" in response) || !["end", "length", "abort"].includes(String(response.stopReason)) || !("meta" in response)) return false
    const meta = response.meta
    return !!meta && typeof meta === "object" && "provider" in meta && typeof meta.provider === "string"
        && "model" in meta && typeof meta.model === "string" && "durationMs" in meta && typeof meta.durationMs === "number"
}

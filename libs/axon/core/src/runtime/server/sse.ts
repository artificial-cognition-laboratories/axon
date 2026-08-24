import { getResponseHeaders, setResponseHeader } from "h3"

/**
 * Sse — the one place this runtime speaks Server-Sent Events.
 *
 * Both streaming endpoints (/_axon/stream and /_axon/events) need the same
 * three things: the SSE response headers, a frame encoder, and the awkward
 * copy of h3's accumulated headers onto a real Response. Owning them here
 * means an endpoint writes only what is actually different about its stream
 * — what it replays, what it forwards, what closes it.
 */

/** h3's event object, as the header helpers accept it. */
type H3Event = Parameters<typeof setResponseHeader>[0]

const encoder = new TextEncoder()

/** One SSE frame. `id` lets a browser EventSource resume via Last-Event-ID. */
export function frame(data: unknown, opts?: { id?: number | string; event?: string }): Uint8Array {
    const lines: string[] = []
    if (opts?.id !== undefined) lines.push(`id: ${opts.id}`)
    if (opts?.event !== undefined) lines.push(`event: ${opts.event}`)
    lines.push(`data: ${JSON.stringify(data)}`)
    return encoder.encode(lines.join("\n") + "\n\n")
}

/**
 * Open an SSE response over a body stream.
 *
 * Sets the content-type/cache/connection headers on the h3 event, then copies
 * everything h3 accumulated onto the returned Response — h3's header state and
 * a web Response are two different places, and only the latter reaches the
 * client.
 */
export function sseResponse(event: H3Event, body: ReadableStream<Uint8Array>): Response {
    setResponseHeader(event, "content-type", "text/event-stream")
    setResponseHeader(event, "cache-control", "no-cache")
    setResponseHeader(event, "connection", "keep-alive")

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(getResponseHeaders(event))) {
        if (typeof value === "string") headers[key] = value
    }
    return new Response(body, { headers })
}

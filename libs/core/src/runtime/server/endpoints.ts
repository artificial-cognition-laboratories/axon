import { createError, defineEventHandler, getResponseHeaders, readBody, setResponseHeader } from "h3"
import type { AxonHandle, AxonBlueprint, AxonRequestInput } from "@arcforge/types"
import { ConnectAuth } from "./connect-auth"
import { H3T } from "./h3"

type EndpointsOpts = {
    h3: H3T
    axon: AxonHandle
    blueprint: AxonBlueprint
}

/**
 * Endpoints — the framework-reserved `/_axon/*` surface every agent exposes,
 * independent of user-authored routes. This is the normalized wire contract a
 * remote client (AxonCloud.attach) speaks to: it never depends on what routes
 * the agent's author did or didn't write.
 *
 * Mounted BEFORE user routes and under the reserved `/_axon` prefix, so an
 * agent can never shadow or collide with it — the contract is guaranteed
 * present on every deployment.
 *
 *   GET  /_axon/health   — readiness. 200 once the runtime is serving.
 *   POST /_axon/request  — one-shot invocation. body {prompt} → AxonResult JSON.
 *   POST /_axon/stream   — streaming invocation. body {prompt} → SSE of AxonEntry.
 *
 * These mirror AxonHandle.request/stream exactly, so a RemoteAgent built on
 * them is transport-transparent for those verbs. Authoring verbs (update,
 * hooks) are deliberately absent — they are meaningless against a remote
 * instance.
 */
export function Endpoints(opts: EndpointsOpts) {
    const { h3, axon } = opts
    const router = h3.router

    // The connect gate — verifies a caller's token with the control plane.
    // Enforces only when the deploy env (AXON_API_BASE + AGENT_ID) is present;
    // open locally. Env comes from the blueprint (the runtime never reads
    // process.env directly).
    const auth = ConnectAuth({
        ...(opts.blueprint.env.AXON_API_BASE ? { apiBase: opts.blueprint.env.AXON_API_BASE } : {}),
        ...(opts.blueprint.env.AGENT_ID ? { agentId: opts.blueprint.env.AGENT_ID } : {}),
    })

    // health carries the instance's session id so a client's attach handshake
    // resolves "which instance am I bound to" up front (mirrors local session.id).
    // Never gated — the startup probe hits it before any caller is authorized.
    router.get("/_axon/health", defineEventHandler(() => ({ ok: true, sessionId: axon.session.id })))

    // Body is parsed BEFORE the auth check, then the action runs only AFTER it.
    // Order matters for correctness: auth.require() awaits a fetch to the control
    // plane, and reading the request body across that async gap fails (the body
    // stream is disturbed). Parsing untrusted input pre-auth is safe here — it's
    // a bounded JSON parse; the agent is never *invoked* until the gate passes.
    router.post("/_axon/request", defineEventHandler(async event => {
        const input = await readInput(event)
        await auth.require(event)
        return await axon.request(input)
    }))

    router.post("/_axon/stream", defineEventHandler(async event => {
        const input = await readInput(event)
        await auth.require(event)
        return streamResponse(event, axon.stream(input))
    }))

    return {
        mounted: ["GET /_axon/health", "POST /_axon/request", "POST /_axon/stream"],
        enforcing: auth.enforcing,
    }
}

/**
 * Normalize the request body into AxonRequestInput. A bare string body, a
 * `{ prompt }` object, or a `{ prompt: string[] }` batch are all accepted — the
 * same shapes AxonHandle.request takes — so the wire and the local call agree.
 * A body with no usable prompt is a 400 at this boundary, not a runtime throw.
 */
async function readInput(event: Parameters<typeof readBody>[0]): Promise<AxonRequestInput> {
    const body = await readBody(event).catch(() => undefined)

    if (typeof body === "string") return { prompt: body }
    if (body && typeof body === "object" && "prompt" in body) {
        const prompt = (body as { prompt: unknown }).prompt
        if (typeof prompt === "string" || Array.isArray(prompt)) {
            return { prompt: prompt as string | string[] }
        }
    }

    throw createError({
        statusCode: 400,
        statusMessage: "_axon/request: body must be a string or { prompt: string | string[] }",
    })
}

/**
 * Stream AxonEntry events to the client as Server-Sent Events. Each entry is
 * one `data:` frame of JSON; a terminal `event: done` frame closes the stream
 * cleanly so the client knows the run finished rather than the socket dropping.
 * A mid-stream failure emits an `event: error` frame before closing — the
 * client must be able to tell "completed" from "broke".
 */
function streamResponse(
    event: Parameters<typeof setResponseHeader>[0],
    run: ReturnType<AxonHandle["stream"]>,
): Response {
    setResponseHeader(event, "content-type", "text/event-stream")
    setResponseHeader(event, "cache-control", "no-cache")
    setResponseHeader(event, "connection", "keep-alive")

    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const entry of run.stream) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`))
                }
                controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`))
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause)
                controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`))
            } finally {
                controller.close()
            }
        },
        cancel() {
            // Client disconnected — cancel the underlying wake so the agent
            // stops working on a response nobody is listening for.
            run.interrupt()
        },
    })

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(getResponseHeaders(event))) {
        if (typeof value === "string") headers[key] = value
    }
    return new Response(body, { headers })
}

import type {
    AxonAgentHandle,
    AxonBlueprint,
    AxonEntry,
    AxonRequestInput,
    AxonResult,
    AxonRun,
    AxonStimulusEntry,
} from "@arcforge/types"
import { MirroredSession } from "./session"

type RemoteAgentOpts = {
    /** Absolute base URL of ONE agent instance, e.g. https://axon-agent-xxx.run.app */
    url: string
    /** The instance's session id, resolved during attach's handshake. */
    sessionId: string
    /** Bearer token presented to the agent's /_axon surface (connect token). Optional while agent auth is unbuilt. */
    token?: string
    /** Injectable fetch for tests; defaults to global fetch. */
    fetch?: typeof fetch
}

/**
 * A handle to ONE deployed agent instance, over HTTPS.
 *
 * ── One handle, three transports ────────────────────────────────────────────
 *
 * This implements `AxonAgentHandle` — the same type a daemon-supervised agent
 * and an in-process one present. The transports differ in how bytes move and
 * in nothing a consumer should have to know, which is what lets a surface
 * written here work against an agent on another machine.
 *
 * The AUTHORING verbs (`prompts`, `run`) are deliberately absent rather than
 * throwing: they read and execute source that lives beside the agent on disk,
 * and a deployment has no project to read. A transport that cannot do
 * something says so by not implementing `AxonAuthoringHandle`, so a caller
 * finds out at the type rather than at the call.
 *
 * A RemoteAgent is bound to one instance for its life — that is what makes
 * "one session, one writer" hold under horizontal scale. It speaks only the
 * framework-reserved `/_axon/*` contract, never the agent's own routes.
 */
export function RemoteAgent(opts: RemoteAgentOpts) {
    const base = opts.url.replace(/\/+$/, "")
    const doFetch = opts.fetch ?? fetch
    const session = MirroredSession({
        url: base,
        sessionId: opts.sessionId,
        ...(opts.token ? { token: opts.token } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
    })

    function headers(contentType: string): Record<string, string> {
        return {
            "content-type": contentType,
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        }
    }

    function normalize(input: AxonRequestInput | string): AxonRequestInput {
        return typeof input === "string" ? { prompt: input } : input
    }

    async function request(input: AxonRequestInput | string): Promise<AxonResult> {
        const res = await doFetch(`${base}/_axon/request`, {
            method: "POST",
            headers: headers("application/json"),
            body: JSON.stringify(normalize(input)),
        })
        if (!res.ok) throw new Error(`_axon/request failed: ${res.status} ${await res.text().catch(() => "")}`)
        return (await res.json()) as AxonResult
    }

    function stream(input: AxonRequestInput | string): AxonRun {
        const controller = new AbortController()

        async function* iterate(): AsyncGenerator<AxonEntry, void, undefined> {
            const res = await doFetch(`${base}/_axon/stream`, {
                method: "POST",
                headers: { ...headers("application/json"), accept: "text/event-stream" },
                body: JSON.stringify(normalize(input)),
                signal: controller.signal,
            })
            if (!res.ok || !res.body) {
                throw new Error(`_axon/stream failed: ${res.status} ${await res.text().catch(() => "")}`)
            }
            // Mirror every entry as it passes through, so session.entries stays
            // current without the consumer having to feed it. absorb() drops
            // anything at or below the cursor, so an entry already hydrated
            // cannot land twice.
            for await (const entry of parseSse(res.body)) {
                session.absorb(entry)
                yield entry
            }
        }

        return {
            stream: iterate(),
            interrupt: () => controller.abort(),
        }
    }

    /**
     * The text a stimulus carries, for the request/stream endpoints.
     *
     * `/_axon/request` speaks `AxonRequestInput` — a deployed agent's HTTP
     * surface predates the handle contract. The entry is the canonical input
     * (a prompt IS `cognet:stimulus:text`), so the narrowing happens here at
     * the transport rather than every caller learning two shapes.
     */
    function promptOf(entry: AxonStimulusEntry): AxonRequestInput {
        const data = (entry as { data?: { content?: unknown } }).data
        if (typeof data?.content !== "string") {
            throw new Error(`a deployed agent accepts text stimuli; received ${entry.type}`)
        }
        return { prompt: data.content }
    }

    const handle: AxonAgentHandle = {
        sessionId: opts.sessionId,

        async stimulus(entry) {
            // Fire and forget: the HTTP surface has no admission-only verb, so
            // the request is issued and its completion ignored. Admission is
            // reported as true because the agent accepted the connection —
            // anything finer needs a verb the deployment does not expose.
            void request(promptOf(entry)).catch(() => {})
            return { admitted: true }
        },

        async request(entry) {
            await request(promptOf(entry))
            return { ok: true }
        },

        stream(entry) {
            return stream(promptOf(entry))
        },

        async interrupt() {
            // A deployment has no out-of-band channel: an interrupt is the
            // consumer aborting its own stream, which `stream().interrupt()`
            // already does. Refused loudly rather than silently doing nothing,
            // because a caller expecting the wake to stop must not be told it
            // did when it did not.
            throw new Error("a deployed agent has no interrupt channel — abort the stream instead")
        },

        async update(_blueprint: AxonBlueprint) {
            throw new Error("a deployed agent cannot be hot-reloaded — deploy a new version")
        },

        async shutdown() {
            throw new Error("a deployed agent's lifetime is the deployment's — stop it from the control plane")
        },

        session,

        async selectModel(_model: string) {
            throw new Error("a deployed agent's engine is fixed at deploy time")
        },
    }

    return {
        ...handle,
        /**
         * The CONCRETE mirror, not the interface's narrowed view.
         *
         * `AxonAgentHandle.session` is deliberately the read surface every
         * transport can offer. This handle's own callers also `hydrate()` it
         * from an attach handshake and read its `id`, which are real verbs on
         * the real object — narrowing them away to satisfy the contract would
         * be the contract removing capability rather than describing it.
         */
        session,
        /**
         * The pre-handle shapes, kept for callers that predate the contract.
         *
         * `request`/`stream` here take `AxonRequestInput`; the handle's take a
         * stimulus entry. Same endpoints either way.
         */
        requestInput: request,
        streamInput: stream,
    }
}

export type RemoteAgentHandle = ReturnType<typeof RemoteAgent>

/**
 * Parse a Server-Sent Events body into AxonEntry values. Each `data:` frame is
 * one JSON entry. The terminal `event: done` frame ends the stream cleanly; an
 * `event: error` frame throws, so a consumer can tell "finished" from "broke"
 * — the same distinction the server end (Endpoints) draws.
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<AxonEntry, void, undefined> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            let boundary: number
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)

                const eventType = frame.match(/^event:\s*(.*)$/m)?.[1]?.trim()
                const dataLine = frame.match(/^data:\s*(.*)$/m)?.[1]

                if (eventType === "done") return
                if (eventType === "error") {
                    const detail = dataLine ? (JSON.parse(dataLine) as { message?: string }).message : undefined
                    throw new Error(`_axon/stream: agent reported an error${detail ? ` — ${detail}` : ""}`)
                }
                if (dataLine) yield JSON.parse(dataLine) as AxonEntry
            }
        }
    } finally {
        reader.releaseLock()
    }
}

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
    /**
     * Where a failure with no caller to throw at goes — currently the turn
     * `stimulus()` leaves running after admission.
     *
     * Defaulted rather than optional-and-ignored: the point is that this path
     * has a destination at all. Dropping such a failure is how a user's message
     * disappears with nothing logged anywhere.
     */
    onError?: (error: Error) => void
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
    const onError = opts.onError ?? ((error: Error) => console.error(`[axon] remote agent: ${error.message}`))
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

    /**
     * Every shape a caller may hand the consumer verbs, mapped to the one shape
     * the wire speaks.
     *
     * A stimulus ENTRY is accepted here, and that is the load-bearing case
     * rather than a convenience. `request`/`stream` below deliberately override
     * the `AxonAgentHandle` members of the same name — and a TypeScript "view"
     * of an object is erased at runtime, so anything holding this as the
     * machine contract and calling `stream(entry)` reaches the CONSUMER
     * function, not the entry-shaped one. Before this accepted entries, that
     * dispatch sent `{type, data}` to the server, which answered 400 "body must
     * be a string or { prompt }" — the TUI attaching to `axon dev` and failing
     * on its first message.
     *
     * Widening the accepted input is the fix rather than removing the override,
     * because both doors are real: the contract's door (a prompt IS
     * `cognet:stimulus:text`) and the mirror's door (`request("hello")` must
     * work the way it does locally). One normalizer means they cannot disagree.
     */
    function normalize(input: AxonRequestInput | string | AxonStimulusEntry): AxonRequestInput {
        if (typeof input === "string") return { prompt: input }
        if ("prompt" in input || "stimuli" in input) return input
        if ("type" in input) return promptOf(input)

        // Loud, not forwarded. Passing an unrecognised object through produced
        // a 400 from the server naming the wrong endpoint, which is a long way
        // from the actual mistake.
        throw new Error(
            `a remote agent accepts a string, { prompt }, or a stimulus entry; received ${JSON.stringify(input)}`,
        )
    }

    async function request(input: AxonRequestInput | string | AxonStimulusEntry): Promise<AxonResult> {
        const res = await doFetch(`${base}/_axon/request`, {
            method: "POST",
            headers: headers("application/json"),
            body: JSON.stringify(normalize(input)),
        })
        if (!res.ok) throw new Error(`_axon/request failed: ${res.status} ${await res.text().catch(() => "")}`)
        return (await res.json()) as AxonResult
    }

    /**
     * POST the wake and resolve once the agent has ACCEPTED it.
     *
     * This is the admission signal, and SSE is what makes it available: the
     * response headers arrive when the agent takes the request, long before the
     * turn finishes. `/_axon/request` cannot answer the same question — it
     * computes the whole result before responding, so awaiting it is awaiting
     * completion.
     */
    async function open(
        input: AxonRequestInput | string | AxonStimulusEntry,
        signal: AbortSignal,
    ): Promise<ReadableStream<Uint8Array>> {
        const res = await doFetch(`${base}/_axon/stream`, {
            method: "POST",
            headers: { ...headers("application/json"), accept: "text/event-stream" },
            body: JSON.stringify(normalize(input)),
            signal,
        })
        if (!res.ok || !res.body) {
            throw new Error(`_axon/stream failed: ${res.status} ${await res.text().catch(() => "")}`)
        }
        // Returned as the BODY, not the Response: `open` has already proven it
        // is present, and handing back a nullable `res.body` would make every
        // caller re-prove it with a `!`.
        return res.body
    }

    function stream(input: AxonRequestInput | string | AxonStimulusEntry): AxonRun {
        const controller = new AbortController()
        // Normalised EAGERLY, before the generator is built. A generator body
        // does not run until something iterates it, so validating in there
        // surfaced a bad input inside whatever drain loop happened to consume
        // the stream — a stack pointing at the consumer rather than at the
        // caller that passed the wrong thing.
        const admission = normalize(input)

        async function* iterate(): AsyncGenerator<AxonEntry, void, undefined> {
            const body = await open(admission, controller.signal)
            // Mirror every entry as it passes through, so session.entries stays
            // current without the consumer having to feed it. absorb() drops
            // anything at or below the cursor, so an entry already hydrated
            // cannot land twice.
            for await (const entry of parseSse(body)) {
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
            /*
             * Admission is AWAITED; only the turn is left running.
             *
             * This was `void request(...).catch(() => {})` returning a hardcoded
             * `admitted: true` — every 400, 500, dropped connection and rejected
             * token discarded while the caller was told the agent took the
             * message. The identical client/server shape mismatch that surfaced
             * on `stream()` as a visible error would have vanished here without
             * a trace.
             *
             * `open()` resolves on acceptance rather than completion, so
             * admission stays a real answer instead of an assumption, and a
             * refusal now throws at the caller.
             */
            const controller = new AbortController()
            const body = await open(entry, controller.signal)

            // The turn itself still runs unwatched — that part was always
            // correct, since admission is not completion. Its entries are
            // mirrored so the session stays current, and a mid-turn transport
            // failure is REPORTED rather than swallowed.
            void (async () => {
                for await (const streamed of parseSse(body)) session.absorb(streamed)
            })().catch((cause: unknown) => {
                onError(cause instanceof Error ? cause : new Error(String(cause)))
            })

            return { admitted: true }
        },

        async request(entry) {
            await request(promptOf(entry))
            return { ok: true }
        },

        async ingest(_entry) {
            // Joining a wake already in flight needs the scheduler's stimuli
            // buffer, which lives inside the runtime process. A deployment is
            // reached over HTTP, where every request is its own conversation
            // and there is no in-flight wake to join. Refused loudly rather
            // than silently starting a NEW wake: a caller asking to add to the
            // current turn would get a second turn instead, which reorders
            // what the user said.
            throw new Error("a deployed agent has no mid-wake ingest channel — use request()")
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
         * The CONSUMER verbs — `request("hello")`, and an `AxonResult` back.
         *
         * These deliberately OVERRIDE the `AxonAgentHandle` members of the
         * same name, and the override is the point of this handle.
         *
         * `AxonAgentHandle` is the machine contract every transport
         * implements: every input is an `AxonStimulusEntry`, because a prompt
         * IS `cognet:stimulus:text` and a second door into the same brain
         * would be a second thing to keep in sync. That contract is explicit
         * that convenience over it "belongs in a helper, never in the
         * contract" — this is that helper, and `attach()` promises exactly it
         * ("request/stream mirror the local axon handle").
         *
         * Mirroring means BOTH halves: the input a caller may pass (a bare
         * string or `{ prompt }`, normalised here) and the value they get back
         * (an `AxonResult` with `text`, not the contract's bare `{ ok }`).
         * Anything less and code written against a local runtime still breaks
         * on a deployed one — which is the asymmetry this whole handle exists
         * to remove.
         *
         * The entry-shaped verbs remain reachable as `stimulus` (admission)
         * and through the `AxonAgentHandle` view of this object, so nothing
         * that speaks the machine contract loses a way in.
         */
        request,
        stream,
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

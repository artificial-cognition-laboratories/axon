import { createError, defineEventHandler, getQuery, readBody, setResponseStatus } from "h3"
import type { AxonBlueprint, AxonHandle, AxonRequestInput } from "@arcforge/types"
import type { EnginesT } from "@arcforge/engines/catalogue"
import type { AxonBusT } from "../../platform"
import { ConnectAuth } from "./connect-auth"
import { H3T } from "./h3"
import { parseQuery, snapshot } from "./session-view"
import { eventStream, runStream } from "./streams"

type EndpointsOpts = {
    h3: H3T
    axon: AxonHandle
    /** Raw bus — /_axon/events bridges it to SSE. Trusted-host-only, never on AxonHandle. */
    bus: AxonBusT
    blueprint: AxonBlueprint
    /**
     * The agent's resolved inference roles, for the health endpoint's
     * `engine` field. Absent when the cognet declared none.
     */
    engines?: EnginesT
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
 *   GET  /_axon/session  — session snapshot (history). ?since/?limit/?include.
 *   GET  /_axon/events   — ambient bus stream (live). Replays from ?since, then live.
 *
 * These mirror AxonHandle.request/stream exactly, so a RemoteAgent built on
 * them is transport-transparent for those verbs. Authoring verbs (update,
 * hooks) are deliberately absent — they are meaningless against a remote
 * instance.
 *
 * The two read surfaces pair up: /session is state-at-a-point, /events is the
 * ordered stream, and `time.seq` joins them. /events replays from a cursor, so a
 * client can use it alone and skip /session entirely.
 *
 * Routing only. The projection each endpoint returns lives in session-view.ts,
 * the two live wires in streams.ts, the SSE mechanics in sse.ts.
 */
/**
 * The engine an agent declares, flattened for the wire.
 *
 * Two shapes reach here and mean the same thing: an EngineRef
 * (`{ provider, model }`) and a constructed AxonEngineDef, whose provider is
 * `name`. A client rendering them differently would make the model row's
 * meaning depend on which form the author's config happened to use, so they
 * are collapsed at this seam rather than downstream.
 *
 * Null when the agent declares nothing — distinct from a provider with no
 * model, which is a real state (`{ provider: "mock" }`).
 */
/**
 * What the agent's PRIMARY role actually resolved to.
 *
 * Reports the binding rather than a declaration, because nothing is declared
 * any more: a user supplies providers, a cognet names roles, and which model
 * serves the cortex is decided at boot. A client rendering "the model this
 * agent is on" wants that answer, and there is no other place to get it.
 *
 * Null when the cognet declares no roles, or none is primary — a pure control
 * loop genuinely has no model, and inventing one would put a dead row in
 * every client's header.
 */
function engineIdentity(engines: EnginesT | undefined): { provider: string; model: string | null } | null {
    const bound = engines?.resolution.bound
    if (!bound?.length) return null

    const primary = bound.find(entry => entry.requirement.primary) ?? bound.find(entry => entry.role === "main")
    if (!primary) return null

    return { provider: primary.capability.provider, model: primary.capability.id }
}

export function Endpoints(opts: EndpointsOpts) {
    const { h3, axon } = opts
    const router = h3.router

    // The connect gate — verifies the caller's capability token locally
    // against the public key this deployment was given. Enforces only when
    // both the key and this agent's id are present (a real deployment); open
    // locally, where there is nothing to verify against and the agent is
    // already inside its owner's trust boundary. Env comes from the blueprint
    // — the runtime never reads process.env directly.
    const auth = ConnectAuth({
        ...(opts.blueprint.env.AXON_JWT_PUBLIC_KEY ? { publicKey: opts.blueprint.env.AXON_JWT_PUBLIC_KEY } : {}),
        ...(opts.blueprint.env.AGENT_ID ? { agentId: opts.blueprint.env.AGENT_ID } : {}),
    })

    // health carries the instance's session id so a client's attach handshake
    // resolves "which instance am I bound to" up front (mirrors local session.id).
    // Never gated — the startup probe hits it before any caller is authorized.
    // Readiness, not liveness. `ok` used to be the literal `true`, so an agent
    // whose brain failed to load answered 200 forever: the process was up, the
    // routes served, the log filled with reload failures, and nothing outside
    // could tell. A health check that cannot fail is not a health check.
    //
    // 503 is the honest status for "running but cannot serve its purpose" —
    // it is what a load balancer needs to stop sending work, and what a human
    // needs to stop trusting the green light.
    // `agent` is the identity a client shows for what it attached TO. A caller
    // that typed a URL has nothing else to render — "localhost:3010" in the
    // slot where an agent name belongs is a hostname pretending to be an
    // identity. A deployment already knows the name from its record; a bare
    // URL can only learn it here, and the handshake is the one round trip
    // every attach already makes.
    router.get("/_axon/health", defineEventHandler(event => {
        const ready = axon.ready
        if (!ready) setResponseStatus(event, 503)
        return {
            ok: ready,
            sessionId: axon.session.id,
            agent: opts.blueprint.agent.name,
            // What this agent is carrying. A client that attached over the
            // wire has no blueprint to read — it never built this agent and
            // never will — so the counts have to come from the agent itself
            // or not exist. No duration: how long the build took is a fact
            // about the process that ran it, and claiming it for a caller
            // that only watched would be someone else's number.
            modules: opts.blueprint.modules?.length ?? 0,
            tools: opts.blueprint.tools?.length ?? 0,
            // The primary role's RESOLVED binding — see engineIdentity.
            engine: engineIdentity(opts.engines),
            // The AUDIENCE a caller must mint a connect token for, when this
            // agent enforces one.
            //
            // Without it a client had to be TOLD the agent id out of band, so
            // `:attach <url>` — which has only a URL — sent no token at all and
            // got a bare 401 from any gated route. The assumption underneath
            // was "local means open", which stopped being true the moment
            // local staging started deploying through the real pipeline: those
            // agents are local AND enforcing.
            //
            // Not a secret. It is the id in the owner's own dashboard, and it
            // grants nothing: the backend still decides whether the caller may
            // have a token for it, and the token it mints is scoped by `aud`
            // to this one agent for minutes. Publishing it turns an
            // unactionable 401 into "ask for a token for this".
            //
            // Absent when the gate is open, which is the honest signal that no
            // token is needed rather than one the client must guess at.
            ...(auth.enforcing && opts.blueprint.env.AGENT_ID
                ? { agentId: opts.blueprint.env.AGENT_ID }
                : {}),
            ...(ready ? {} : { reason: "no cognet loaded" }),
        }
    }))

    // Body is parsed BEFORE the auth check, then the action runs only AFTER it.
    //
    // This looks backwards and is not. Verification awaits — the RS256 public
    // key is imported asynchronously on first use — and h3's request body
    // cannot be read across an await boundary: the stream is already disturbed
    // by the time the handler resumes, and the read fails. So the body is
    // taken first, while the request is still intact.
    //
    // Safe, because parsing is not acting: readInput does a bounded JSON parse
    // and nothing else. The agent is never INVOKED until the gate passes, which
    // is the property that matters.
    router.post("/_axon/request", defineEventHandler(async event => {
        const input = await readInput(event)
        await auth.require(event, "request")
        return await axon.request(input)
    }))

    router.post("/_axon/stream", defineEventHandler(async event => {
        const input = await readInput(event)
        await auth.require(event, "stream")
        return runStream(event, axon.stream(input))
    }))

    // The session snapshot — what makes a deployed agent render identically to a
    // local one. A remote client has no in-process session to read, so it
    // hydrates from here on attach and appends from the stream afterwards.
    // Gated: unlike /health (which the startup probe hits pre-auth), this is the
    // agent's whole conversation and telemetry.
    router.get("/_axon/session", defineEventHandler(async event => {
        await auth.require(event, "read")
        return snapshot(axon, parseQuery(getQuery(event)))
    }))

    // The ambient event channel — the runtime bus, over the wire. A remote
    // client subscribes here and routes events into its mirrored session
    // exactly as a local consumer routes bus.onAny(), which is what makes a
    // deployed agent observable with no second code path.
    //
    // Distinct from POST /_axon/stream on purpose: that is request-scoped (it
    // tells you YOUR turn finished and owns interrupt() for YOUR wake). This is
    // everything happening in the session, including events between turns that a
    // request-scoped stream can never see.
    router.get("/_axon/events", defineEventHandler(async event => {
        await auth.require(event, "read")
        return eventStream(event, {
            bus: opts.bus,
            session: axon.session,
            query: parseQuery(getQuery(event)),
        })
    }))

    return {
        mounted: [
            "GET /_axon/health",
            "POST /_axon/request",
            "POST /_axon/stream",
            "GET /_axon/session",
            "GET /_axon/events",
        ],
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

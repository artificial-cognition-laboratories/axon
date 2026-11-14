import { err } from "@arcforge/err"
import type {
    AgentToSupervisor,
    AxonBlueprint,
    AxonEngineDriver,
    AxonEngineRawEvent,
    AxonTransformDriver,
    AxonCommitContext,
    AxonEngineRequest,
    AxonIngest,
    AxonStimulusEntry,
    AxonStimulusInput,
    ServeInput,
    SupervisorToAgent,
} from "@arcforge/types"
import { VERB } from "./supervisor"
import type { LinkChannels } from "./socket"

/**
 * The agent side of the link: what a confined agent serves, and how it reaches
 * the services it is not allowed to hold.
 */

export type AgentServices = {
    /** Deliver a stimulus and resolve when the wake it caused settles. */
    request(input: AxonStimulusEntry | { content?: string | string[]; stimuli?: AxonStimulusInput[]; channel?: string }): Promise<{ ok: boolean; interrupted?: boolean }>
    /** Execute code in the agent's scope — the console/devtools eval. */
    run(code: string): Promise<unknown>
    /** The agent's prompt surface: list, get one, render an entry. */
    prompts(request: { action: string; name?: string; entry?: unknown; props?: Record<string, unknown> }): Promise<unknown>
    /** Bind the agent's HTTP surface in its own process; reports the bound port. */
    serve(input: ServeInput): Promise<{ port: number }>
    /** Deliver a stimulus to the scheduler. Returns whether the brain admitted it. */
    stimulus(entry: AxonStimulusEntry): Promise<{ admitted: boolean }>
    /** Add a message to the wake already running — no reservation, no verdict. */
    ingest(input: AxonIngest): Promise<void>
    /** Hot reload. */
    update(blueprint: AxonBlueprint): Promise<void>
    /** Abort the active wake. */
    interrupt(reason: "user" | "shutdown"): void
    /** Drain and exit. */
    shutdown(): Promise<void>
}

/**
 * The handlers an agent serves to its supervisor.
 *
 * Everything the outside can say to a running agent, and nothing else. Note
 * there is no `wake`: the supervisor emits a STIMULUS and the brain decides
 * whether to wake for it, which is the scheduler's own admission policy. A
 * `wake` verb would overrule that decision from outside the mind it belongs to.
 */
export function agentHandlers(services: AgentServices) {
    return {
        control: {
            async call(verb: string, arg: unknown): Promise<unknown> {
                switch (verb) {
                    case VERB.stimulus: return services.stimulus(arg as AxonStimulusEntry)
                    case VERB.ingest: return services.ingest(arg as AxonIngest)
                    case VERB.update: return services.update(arg as AxonBlueprint)
                    case VERB.shutdown: return services.shutdown()
                    case VERB.request: return services.request(arg as Parameters<AgentServices["request"]>[0])
                    case VERB.run: return services.run(arg as string)
                    case VERB.prompts: return services.prompts(arg as { action: string })
                    case VERB.serve: return services.serve(serveInput(arg))
                    default: throw err("LINK_NO_HANDLER", { detail: verb, context: { verb } })
                }
            },
            send(verb: string, arg: unknown): void {
                if (verb !== VERB.interrupt) throw err("LINK_NO_HANDLER", { detail: verb, context: { verb } })
                services.interrupt(arg as "user" | "shutdown")
            },
        },
        // The agent asks for inference and commits; it never serves them.
        data: {},
    }
}

/**
 * RemoteDriver — an `AxonEngineDriver` whose tokens arrive over the wire.
 *
 * This is the swap that keeps the credential out of the box, and it is
 * deliberately a DRIVER rather than a new seam. `AxonEngineDriver` is already
 * defined as "a dumb token pipe: messages in, raw deltas out — no AIR parsing,
 * no bus, no blocks", which is exactly what a wire is. So the Engine() manager
 * agent-side keeps owning AIR, retries, telemetry and the stall guard, and
 * cannot tell that the tokens crossed a process boundary to reach it.
 *
 * The agent names a ROLE. It never sees a model id, a provider, or a key —
 * the same indirection the kernel already used to keep cognition from learning
 * what is behind a role, now enforced by the boundary rather than by
 * convention.
 */
export function RemoteDriver(opts: {
    role: string
    supervisor: AgentToSupervisor
    /**
     * A fallback signal, for a caller that has one at construction.
     *
     * Almost nothing does — `Axon()` builds this as `role => RemoteDriver({
     * role, supervisor })`, long before any wake exists — which is exactly why
     * the REQUEST'S signal is what actually matters below.
     */
    signal?: AbortSignal
}): AxonEngineDriver {
    return {
        kind: "generate",
        async *stream(request: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> {
            /**
             * The REQUEST's signal, not one captured at construction.
             *
             * `AxonEngineRequest.signal` is the contract — "engines must abort
             * in-flight work when fired" — and it carries the WAKE's
             * cancellation, minted per run. A driver built once at boot has no
             * wake to capture, so reading `opts.signal` handed every stream a
             * fresh controller that nobody ever aborted: interrupt reached the
             * scheduler, the scheduler aborted the wake, and the engine stream
             * carried on to completion regardless. The user saw the spinner
             * stop, the reply arrive anyway, and the interrupt marker appear
             * after it.
             *
             * The request's signal wins; `opts.signal` remains a fallback for
             * a caller that genuinely has one.
             */
            const signal = request.signal ?? opts.signal ?? new AbortController().signal
            yield* opts.supervisor.infer({ role: opts.role, request }, signal)
        },
    }
}

/**
 * RemoteTransform — an `AxonTransformDriver` whose work happens where the
 * engines are.
 *
 * The same swap RemoteDriver makes for generation: the agent's kernel keeps
 * tracing the call, and cannot tell that the image crossed a process to be
 * looked at. The wake's signal travels with the call, so an interrupted wake
 * stops waiting for a result it no longer wants.
 */
export function RemoteTransform(opts: { role: string; supervisor: AgentToSupervisor }): AxonTransformDriver {
    return {
        kind: "transform",
        transform(input: unknown, transformOpts) {
            return opts.supervisor.transform({ role: opts.role, input: input }, transformOpts?.signal ?? new AbortController().signal)
        },
    }
}

/**
 * The most commits one batch carries before it is sent without waiting for
 * the turn to end — a burst never builds an unbounded message.
 */
const BATCH_MOST = 512

/**
 * The supervisor, as the agent calls it.
 *
 * Commits are BATCHED: gathered for one turn of the event loop and sent as
 * one `commits` message, in order. A continuous mind commits dozens of
 * telemetry events a tick, and one link message each was a frame, an encode
 * and a decode apiece — the batch is one of each per tick. The order of the
 * log is untouched: every commit waits the same way, so none overtakes
 * another.
 */
export function supervisorProxy(channels: LinkChannels): AgentToSupervisor {
    let pending: Array<{ type: string; data: unknown; ctx?: AxonCommitContext }> = []
    let scheduled = false
    const flush = () => {
        scheduled = false
        if (pending.length === 0) return
        const batch = pending
        pending = []
        channels.data.send(VERB.commits, batch)
    }

    return {
        infer(call, signal) {
            return channels.data.stream<AxonEngineRawEvent>(VERB.infer, call, signal)
        },
        transform(call, signal) {
            return channels.data.call(VERB.transform, call, signal)
        },
        commit(type, data, ctx) {
            pending.push({ type: type as string, data: data, ...(ctx ? { ctx } : {}) })
            if (pending.length >= BATCH_MOST) flush()
            else if (!scheduled) {
                scheduled = true
                setImmediate(flush)
            }
        },
        escalate(call) {
            return channels.control.call<{ allow: boolean }>(VERB.escalate, call)
        },
    }
}

/** Type-level assurance that the served handlers cover the whole contract. */
export type AgentSide = SupervisorToAgent

/** The serve verb's argument, checked where it arrives rather than cast. */
function serveInput(arg: unknown): ServeInput {
    const input = arg as Partial<ServeInput> | null
    const valid = input !== null && typeof input === "object"
        && typeof input.port === "number" && Number.isInteger(input.port) && input.port >= 0
        && (input.host === "loopback" || input.host === "all")
        && (input.token === null || (typeof input.token === "string" && input.token.length >= 32))
    if (!valid) throw err("LINK_SERVE_INVALID", { detail: JSON.stringify(arg), context: { arg: arg } })
    return input as ServeInput
}

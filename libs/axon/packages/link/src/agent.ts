import { err } from "@arcforge/err"
import type {
    AgentToSupervisor,
    AxonBlueprint,
    AxonEngineDriver,
    AxonEngineRawEvent,
    AxonEngineRequest,
    AxonStimulusEntry,
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
    request(entry: AxonStimulusEntry): Promise<{ ok: boolean; interrupted?: boolean }>
    /** Execute code in the agent's scope — the console/devtools eval. */
    run(code: string): Promise<unknown>
    /** The agent's prompt surface: list, get one, render an entry. */
    prompts(request: { action: string; name?: string; entry?: unknown; props?: Record<string, unknown> }): Promise<unknown>
    /** Bind the agent's HTTP surface in its own process; reports the bound port. */
    serve(port: number): Promise<{ port: number }>
    /** Deliver a stimulus to the scheduler. Returns whether the brain admitted it. */
    stimulus(entry: AxonStimulusEntry): Promise<{ admitted: boolean }>
    /** Add a message to the wake already running — no reservation, no verdict. */
    ingest(entry: AxonStimulusEntry): Promise<void>
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
                    case VERB.ingest: return services.ingest(arg as AxonStimulusEntry)
                    case VERB.update: return services.update(arg as AxonBlueprint)
                    case VERB.shutdown: return services.shutdown()
                    case VERB.request: return services.request(arg as AxonStimulusEntry)
                    case VERB.run: return services.run(arg as string)
                    case VERB.prompts: return services.prompts(arg as { action: string })
                    case VERB.serve: return services.serve(arg as number)
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

/** The supervisor, as the agent calls it. */
export function supervisorProxy(channels: LinkChannels): AgentToSupervisor {
    return {
        infer(call, signal) {
            return channels.data.stream<AxonEngineRawEvent>(VERB.infer, call, signal)
        },
        commit(type, data, ctx) {
            channels.data.send(VERB.commit, { type, data, ...(ctx ? { ctx } : {}) })
        },
        escalate(call) {
            return channels.control.call<{ allow: boolean }>(VERB.escalate, call)
        },
    }
}

/** Type-level assurance that the served handlers cover the whole contract. */
export type AgentSide = SupervisorToAgent

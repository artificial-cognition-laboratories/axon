import { err } from "@arcforge/err"
import type {
    AgentToSupervisor,
    AxonBlueprint,
    AxonCommitContext,
    AxonEngineRawEvent,
    AxonEventMap,
    AxonStimulusEntry,
    EscalationCall,
    InferCall,
    SupervisorToAgent,
} from "@arcforge/types"
import type { LinkChannels } from "./socket"

/**
 * SupervisorLink — the supervisor's handle on one confined agent.
 *
 * Implements `SupervisorToAgent` by calling across the wire, and serves
 * `AgentToSupervisor` from the services the agent must never hold: the
 * provider driver, the session log, the escalation decider.
 *
 * The credential rule this exists to enforce, restated because it is the whole
 * reason for the boundary: an asset whose loss is unrecoverable and whose
 * stolen form is portable never enters the untrusted process. A stolen file is
 * one machine's data; a stolen provider key works from anywhere, forever. So
 * the agent can CAUSE inference and can never obtain, transfer, or outlive the
 * credential that performs it.
 */

export type SupervisorServices = {
    /**
     * Run one inference call. Holds the credential; yields raw deltas.
     *
     * The boundary lands on a seam that already existed: `AxonEngineDriver` is
     * "a dumb token pipe — messages in, raw deltas out", while the Engine()
     * MANAGER owns AIR parsing, retries and telemetry. The driver stays here,
     * the manager moves agent-side, and AIR never crosses.
     */
    infer(call: InferCall, signal: AbortSignal): AsyncIterable<AxonEngineRawEvent>
    /**
     * Append to the session log. The agent may add to the record, never
     * rewrite it.
     *
     * `ctx` carries the event's correlation ids (runId, spanId) across the
     * seam. It is not optional decoration: the agent's kernel mints a spanId
     * per engine call and the three events of that call are correlated by
     * nothing else, so a commit verb that could not carry it silently
     * un-correlated every span the moment agents moved into subprocesses.
     * Absent means the committer genuinely had no context, never that the
     * boundary lost it.
     */
    commit<K extends keyof AxonEventMap>(type: K, data: AxonEventMap[K], ctx?: AxonCommitContext): void
    /** Ask a human. Absent = no decider attached, which means deny. */
    escalate?(call: EscalationCall): Promise<{ allow: boolean }>
}

type SupervisorLinkOpts = {
    channels: LinkChannels
    services: SupervisorServices
    onError(error: Error): void
}

/** Verb names on the wire. Kept as constants so both ends cannot drift on a typo. */
export const VERB = {
    stimulus: "stimulus",
    ingest: "ingest",
    update: "update",
    interrupt: "interrupt",
    shutdown: "shutdown",
    request: "request",
    run: "run",
    prompts: "prompts",
    serve: "serve",
    infer: "infer",
    commit: "commit",
    escalate: "escalate",
} as const

export function SupervisorLink(opts: SupervisorLinkOpts): SupervisorToAgent & { close(): void } {
    const { channels } = opts

    return {
        /**
         * Deliver a stimulus. Resolves on ADMISSION, never on completion.
         *
         * A continuous cognet ticks whether or not the last wake finished, so
         * resolving on completion would serialise that overlap and turn a mind
         * under a clock into a queue. The scheduler may legitimately refuse one
         * arriving mid-wake — that verdict comes back as `admitted: false`,
         * which is an answer, not a failure.
         */
        stimulus(entry: AxonStimulusEntry) {
            return channels.control.call<{ admitted: boolean }>(VERB.stimulus, entry)
        },

        /**
         * Add a message to the wake already running.
         *
         * On the CONTROL channel for the same reason `interrupt` is: it must
         * land WHILE inference streams on the data channel, not queue behind
         * the tokens it is meant to join.
         */
        ingest(entry: AxonStimulusEntry) {
            return channels.control.call<void>(VERB.ingest, entry)
        },

        update(blueprint: AxonBlueprint) {
            return channels.control.call<void>(VERB.update, blueprint)
        },

        /**
         * Abort the active wake. Fire-and-forget on the CONTROL channel.
         *
         * Sync and unacknowledged deliberately: it must land while inference is
         * streaming on the data channel, and waiting for a reply would couple it
         * to an agent that is busy doing the thing being interrupted.
         */
        interrupt(reason: "user" | "shutdown") {
            channels.control.send(VERB.interrupt, reason)
        },

        shutdown() {
            return channels.control.call<void>(VERB.shutdown, null)
        },

        /**
         * Deliver a stimulus and wait for its wake to settle.
         *
         * On CONTROL rather than data: an interactive turn must not queue
         * behind a token stream, and the reply this waits on IS that stream's
         * completion — putting it on the same channel would make it wait for
         * itself.
         */
        request(entry) {
            return channels.control.call<{ ok: boolean; interrupted?: boolean }>(VERB.request, entry)
        },

        /**
         * On CONTROL, not data: a console eval is a human waiting at a prompt,
         * and making it queue behind a token stream would make the devtools
         * feel hung exactly when someone is trying to debug why.
         */
        run(code: string) {
            return channels.control.call(VERB.run, code)
        },

        prompts(request) {
            return channels.control.call(VERB.prompts, request)
        },

        serve(port) {
            return channels.control.call(VERB.serve, port) as Promise<{ port: number }>
        },

        close() {
            channels.close()
        },
    }
}

/**
 * The handlers a supervisor serves — what the agent is allowed to ask for.
 *
 * Split across the two channels by whether the request can be made to wait
 * behind inference. `escalate` is on control because a human decision can take
 * 30 seconds and must not sit behind a token stream; `commit` and `infer` are
 * on data because they ARE the stream.
 */
export function supervisorHandlers(services: SupervisorServices) {
    return {
        control: {
            async call(verb: string, arg: unknown): Promise<unknown> {
                if (verb !== VERB.escalate) throw err("LINK_NO_HANDLER", { detail: verb, context: { verb } })
                // No decider attached (a script, a headless run) means deny.
                // An unanswered escalation must never read as permission.
                if (!services.escalate) return { allow: false }
                return services.escalate(arg as EscalationCall)
            },
        },
        data: {
            send(verb: string, arg: unknown): void {
                if (verb !== VERB.commit) throw err("LINK_NO_HANDLER", { detail: verb, context: { verb } })
                const { type, data, ctx } = arg as {
                    type: keyof AxonEventMap
                    data: AxonEventMap[keyof AxonEventMap]
                    ctx?: AxonCommitContext
                }
                services.commit(type, data, ctx)
            },
            stream(verb: string, arg: unknown, signal: AbortSignal): AsyncIterable<unknown> {
                if (verb !== VERB.infer) throw err("LINK_NO_HANDLER", { detail: verb, context: { verb } })
                return services.infer(arg as InferCall, signal)
            },
        },
    }
}

/** The agent-facing half, as the agent calls it. Built over the same channels. */
export function agentServices(channels: LinkChannels): AgentToSupervisor {
    return {
        infer(call: InferCall, signal: AbortSignal) {
            return channels.data.stream<AxonEngineRawEvent>(VERB.infer, call, signal)
        },
        commit(type, data, ctx) {
            channels.data.send(VERB.commit, { type, data, ...(ctx ? { ctx } : {}) })
        },
        escalate(call: EscalationCall) {
            return channels.control.call<{ allow: boolean }>(VERB.escalate, call)
        },
    }
}

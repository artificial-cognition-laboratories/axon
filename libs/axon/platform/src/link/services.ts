import { err } from "@arcforge/err"
import { AxonSession } from "@arcforge/session"
import { AxonBus } from "@arcforge/core"
import type { AxonBlueprint, AxonEngineRawEvent, EngineCapability, InferCall } from "@arcforge/types"
import type { AxonCloudClient } from "@arcforge/cloud"
import { Inference } from "@arcforge/core"
import type { EnginesT } from "@arcforge/engines/catalogue"

/**
 * What the SUPERVISOR holds on a confined agent's behalf.
 *
 * The three assets that must never enter the box, assembled in one place so
 * the rule is readable rather than scattered:
 *
 *   inference — holds the provider credential. The agent names a ROLE and
 *               receives tokens; it can cause inference and can never obtain,
 *               transfer, or outlive the key that performs it.
 *   session   — the audit log. The agent APPENDS through commit and can never
 *               rewrite: an attacker who can edit the record has erased the
 *               evidence of everything else.
 *   escalate  — the human decider. A program able to reach it could raise and
 *               answer its own escalations.
 */

type ServicesOpts = {
    blueprint: AxonBlueprint
    cloud: AxonCloudClient
    /** Where the log lives. Opened here, on the supervisor's side. */
    sessionId: string
    /** The daemon-owned local inference bridge for this machine. */
    local?: { catalogue(): Promise<EngineCapability[]>; run(model: string, prompt: string): Promise<string> }
}

export async function SupervisorSideServices(opts: ServicesOpts) {
    /**
     * The supervisor's own bus for this agent.
     *
     * A linked agent has no in-heap runtime to announce on, so this is where
     * its events become observable: every commit the agent makes lands in the
     * session AND fans out here, which is the same contract `runtime.bus`
     * gives an in-process one. Surfaces subscribe to it identically.
     */
    const bus = AxonBus()

    // The log is opened BEFORE the agent exists, so a boot that fails still
    // leaves a readable record of how far it got.
    const session = await AxonSession({
        blueprint: { ...opts.blueprint, session: { id: opts.sessionId } } as AxonBlueprint,
        bus,
    })

    /**
     * Role resolution belongs to this side of the boundary, but it does NOT
     * belong on the readiness path. A provider catalogue can take a second to
     * answer while routes, tools and the control surface are already usable.
     *
     * One promise coalesces concurrent first requests. A failed resolution is
     * deliberately not retained: the requesting inference receives the error
     * loudly, and a later request may retry after the provider recovers.
     */
    let engines: EnginesT | undefined
    let resolving: Promise<EnginesT | undefined> | null = null

    async function resolve(): Promise<EnginesT | undefined> {
        if (engines) return engines
        if (!resolving) {
            resolving = Inference({
                blueprint: opts.blueprint,
                cloud: opts.cloud,
                session,
                ...(opts.local ? { local: opts.local } : {}),
            }).then(value => {
                engines = value
                return value
            }).catch(cause => {
                resolving = null
                throw cause
            })
        }
        return resolving
    }

    return {
        session,

        /** Where a surface watches this agent — the linked counterpart of runtime.bus. */
        bus,

        /** One inference call, performed here, streamed back as raw deltas. */
        async *infer(call: InferCall, signal: AbortSignal): AsyncGenerator<AxonEngineRawEvent> {
            const bound = (await resolve())?.get(call.role)
            if (!bound) {
                throw err("ENGINE_ROLE_UNBOUND_LINK", { detail: `no engine bound to "${call.role}"`, context: { role: call.role } })
            }
            const driver = bound.driver
            if (driver.kind !== undefined && driver.kind !== "generate") {
                throw err("ENGINE_KIND_MISMATCH_LINK", { detail: `role "${call.role}" is bound to a ${driver.kind} driver`, context: { role: call.role, kind: driver.kind } })
            }
            for await (const event of driver.stream({ ...call.request, signal } as never)) {
                if (signal.aborted) break
                yield event
            }
        },

        async close() {
            await session.end()
        },
    }
}

export type SupervisorSideServicesT = Awaited<ReturnType<typeof SupervisorSideServices>>

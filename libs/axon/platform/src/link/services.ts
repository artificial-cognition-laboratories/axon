import { err } from "@arcforge/err"
import { AxonSession } from "@arcforge/session"
import { AxonBus } from "@arcforge/core"
import type { AxonBlueprint, AxonEngineRawEvent, EngineCapability, InferCall } from "@arcforge/types"
import type { AxonCloudClient } from "@arcforge/cloud"
import { Inference } from "@arcforge/core"

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
     * Roles resolved ONCE, on this side.
     *
     * The agent never resolves a role: resolution means reaching the user's
     * providers over the network and building a driver from a credential,
     * which is exactly the work the boundary exists to keep out of the box.
     */
    const engines = await Inference({
        blueprint: opts.blueprint,
        cloud: opts.cloud,
        session,
        ...(opts.local ? { local: opts.local } : {}),
    })

    return {
        session,

        /**
         * The resolved inference roles — the SUPERVISOR's, because it is the
         * side that holds the credential and did the resolving.
         *
         * Exposed so a model switch can rebind the live binding. `setModel`
         * reached for `runtime.kernel.engines`, which exists only for an
         * in-heap agent: for a linked one it was null, the rebind silently did
         * nothing, and the header had no resolved capability to render.
         */
        engines,

        /**
         * The primary role's resolved binding, flattened for the wire.
         *
         * The agent cannot compute this: resolving needs the credential,
         * which is the one thing the boundary keeps on this side. So the
         * answer is carried on the blueprint (see AxonBlueprint.engine) and
         * `/_axon/health` reports it from there rather than from a kernel
         * that, for a confined agent, has no engines at all.
         *
         * Null for a cognet with no roles or no primary — a pure control loop
         * genuinely has no model.
         */
        get engine(): { provider: string; model: string | null } | null {
            const bound = engines?.resolution.bound
            if (!bound?.length) return null

            const primary = bound.find(entry => entry.requirement.primary)
                ?? bound.find(entry => entry.role === "main")
            if (!primary) return null

            return { provider: primary.capability.provider, model: primary.capability.id }
        },

        /** Where a surface watches this agent — the linked counterpart of runtime.bus. */
        bus,

        /** One inference call, performed here, streamed back as raw deltas. */
        async *infer(call: InferCall, signal: AbortSignal): AsyncGenerator<AxonEngineRawEvent> {
            const bound = engines?.get(call.role)
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

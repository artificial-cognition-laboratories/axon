import { err } from "@arcforge/err"
import { AxonSession } from "@arcforge/session"
import { AxonBus } from "@arcforge/core"
import type { AxonBlueprint, AxonEngineRawEvent, EngineCapability, InferCall, ResolvedEngineFacts, TransformCall } from "@arcforge/types"
import type { AxonCloudClient } from "@arcforge/cloud"
import { Inference } from "@arcforge/core"
import type { LocalRuntime, EnginesT } from "@arcforge/engines/catalogue"

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
    local?: LocalRuntime
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

    const selection = {
        get current() { return engines },
        get primary() { return engines?.primary ?? null },
        has: (role: string) => engines?.has(role) ?? false,
        get(role: string) {
            if (!engines) throw err("ENGINE_ROLE_UNBOUND_LINK", { detail: "inference has not been resolved" })
            return engines.get(role)
        },
        async refresh(provider: string): Promise<void> {
            const current = await resolve()
            if (!current) throw err("ENGINE_ROLE_UNBOUND_LINK", { detail: "this agent declares no inference roles" })
            await current.refresh(provider)
        },
        async select(model: string): Promise<EngineCapability | null> {
            const current = await resolve()
            return current ? current.select(model) : null
        },
        /**
         * What each BOUND role got, as the facts a confined agent may know —
         * type, modalities, context, slots; never a provider or a model. What
         * lets `kernel.engine.has()` inside the box tell a filled optional
         * role from an empty one.
         */
        async facts(): Promise<Record<string, ResolvedEngineFacts>> {
            const current = await resolve()
            const facts: Record<string, ResolvedEngineFacts> = {}
            for (const binding of current?.resolution.bound ?? []) {
                facts[binding.role] = {
                    type: binding.requirement.type,
                    ...(binding.capability.context !== undefined ? { context: binding.capability.context } : {}),
                    modalities: { in: [...binding.capability.in], out: [...binding.capability.out] },
                    slots: binding.slots,
                }
            }
            return facts
        },
    }

    return {
        engines: selection,
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

        /**
         * One transform, performed here, its result sent back whole.
         *
         * Traced agent-side, where the kernel brackets every transform; this
         * side only performs it. The wake's signal crossed with the call, so a
         * wake that ends stops the wait — the model's own work cannot be
         * cancelled mid-graph and finishes unobserved.
         */
        async transform(call: TransformCall, signal: AbortSignal): Promise<unknown> {
            const bound = (await resolve())?.get(call.role)
            if (!bound) {
                throw err("ENGINE_ROLE_UNBOUND_LINK", { detail: `no engine bound to "${call.role}"`, context: { role: call.role } })
            }
            const driver = bound.driver
            if (driver.kind !== "transform") {
                throw err("ENGINE_KIND_MISMATCH_LINK", { detail: `role "${call.role}" is bound to a ${driver.kind ?? "generate"} driver, not a transform`, context: { role: call.role, kind: driver.kind ?? "generate" } })
            }
            signal.throwIfAborted()
            return await driver.transform(call.input, { signal: signal })
        },

        async close() {
            await session.end()
        },
    }
}

export type SupervisorSideServicesT = Awaited<ReturnType<typeof SupervisorSideServices>>

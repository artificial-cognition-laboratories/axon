import { err, isAxonError } from "@arcforge/err"
import type { AxonError } from "@arcforge/err"
import type { CognetUse, KernelServices, ProviderSession, ServiceGrants, ServiceProvider, ServiceState } from "@arcforge/types"
import { Handles } from "./handles"

/** The span of one service call, as the session records it. */
type Span = { runId: string; spanId: string }

type ServicesOpts = {
    /** What the cognet declared in `uses:`, each with its interface as compiled — read per call: a reload can change it. */
    uses(): Readonly<Record<string, CognetUse>>
    /** What the agent granted — read per call, so a provider that comes or goes is seen at once. */
    grants: ServiceGrants
    /** The wake a call is made in: its run, and its cancellation. */
    active(): { runId: string; signal: AbortSignal }
    /** Records one event of a call's span in the agent's session. */
    record(type: `kernel:service:${"start" | "complete" | "failed" | "interrupted"}`, data: Record<string, unknown>, span: Span): Promise<void>
}

/** An open session: which use, which provider, and the span its lifetime is recorded as. */
type Open = { use: string; method: string; provider: ServiceProvider; session: ProviderSession; span: Span; opened: number }

/**
 * Services — the cognet's uses, served by whatever the agent granted.
 *
 * Every call is checked against the use's interface (a declared use, a method
 * it has, called as its kind), reaches the provider granted NOW, and is
 * recorded in the agent's session with the provider that answered. The
 * cognet is handed the interface's answer and nothing else: never which
 * provider, never what it cost. Handles are renamed on the way out and back
 * (see Handles), and sessions are held by an id of the kernel's.
 */
export function Services(opts: ServicesOpts) {
    const handles = Handles()
    const sessions = new Map<string, Open>()
    const granted = (use: string) => opts.grants.granted(use)

    return {
        state(): Record<string, ServiceState> {
            return Object.fromEntries(Object.keys(opts.uses()).map(use => {
                const provider = granted(use)
                return [use, { available: provider !== null, describe: provider ? provider.describe() : null }]
            }))
        },

        async call(use: string, method: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
            const provider = serving(use, method, "call")
            const run = opts.active()
            return traced({ use: use, method: method, kind: "call", provider: provider, run: run }, async () => {
                const answer = await provider.call(method, taken(use, provider, args), signal ? AbortSignal.any([signal, run.signal]) : run.signal)
                return handles.given(use, provider, answer)
            })
        },

        stream(use: string, method: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
            const provider = serving(use, method, "stream")
            const run = opts.active()
            return streamed({ use: use, method: method, provider: provider, run: run }, provider.stream(method, taken(use, provider, args), signal ? AbortSignal.any([signal, run.signal]) : run.signal))
        },

        async open(use, method) {
            const provider = serving(use, method, "session")
            const span = { runId: opts.active().runId, spanId: Bun.randomUUIDv7() }
            await opts.record("kernel:service:start", { use: use, method: method, kind: "session", provider: provider.name }, span)
            let session: ProviderSession
            try {
                session = await provider.open(method)
            } catch (cause) {
                const failure = refused(cause, use, method)
                await opts.record("kernel:service:failed", { use: use, method: method, error: failure }, span)
                throw failure
            }
            const id = `${use}:${Bun.randomUUIDv7()}`
            sessions.set(id, { use: use, method: method, provider: provider, session: session, span: span, opened: Date.now() })
            return id
        },

        async push(id, value) {
            const open = opened(id)
            try {
                return handles.given(open.use, open.provider, await open.session.push(taken(open.use, open.provider, value)))
            } catch (cause) {
                throw refused(cause, open.use, open.method)
            }
        },

        async reset(id) {
            await opened(id).session.reset()
        },

        async close(id) {
            const open = opened(id)
            sessions.delete(id)
            await open.session.close()
            await opts.record("kernel:service:complete", { use: open.use, method: open.method }, open.span)
        },

        release(id) {
            return handles.release(id, granted)
        },
    } satisfies KernelServices

    /** The provider granted to `use` now, after checking the call is one its interface makes. */
    function serving(use: string, method: string, kind: "call" | "stream" | "session"): ServiceProvider {
        const declared = opts.uses()[use]
        if (!declared) throw err("SERVICE_INVALID", { detail: `${use} is no use this cognet declares in uses`, context: { use: use } })
        const found = declared.methods[method]
        if (!found) throw err("SERVICE_INVALID", { detail: `${declared.named} has no method ${method}`, context: { use: use, method: method } })
        if (found.kind !== kind) throw err("SERVICE_INVALID", { detail: `${declared.named}'s ${method} is a ${found.kind}, not a ${kind}`, context: { use: use, method: method } })
        const provider = granted(use)
        if (!provider) throw err("SERVICE_UNAVAILABLE", { detail: `${use} is not available — nothing fills it; ask \`available\` first`, context: { use: use } })
        return provider
    }

    function taken(use: string, provider: ServiceProvider, args: unknown): Record<string, unknown> {
        return handles.taken(use, provider, args) as Record<string, unknown>
    }

    function opened(id: string): Open {
        const open = sessions.get(id)
        if (!open) throw err("SERVICE_INVALID", { detail: `session ${id} is not open`, context: { session: id } })
        return open
    }

    async function traced<T>(call: { use: string; method: string; kind: "call"; provider: ServiceProvider; run: { runId: string } }, answer: () => Promise<T>): Promise<T> {
        const span = { runId: call.run.runId, spanId: Bun.randomUUIDv7() }
        await opts.record("kernel:service:start", { use: call.use, method: call.method, kind: call.kind, provider: call.provider.name }, span)
        try {
            const value = await answer()
            await opts.record("kernel:service:complete", { use: call.use, method: call.method }, span)
            return value
        } catch (cause) {
            const failure = refused(cause, call.use, call.method)
            await opts.record("kernel:service:failed", { use: call.use, method: call.method, error: failure }, span)
            throw failure
        }
    }

    /** A stream's answers, its span open to its end — interrupted when its reader leaves before it. */
    async function* streamed(call: { use: string; method: string; provider: ServiceProvider; run: { runId: string } }, answers: AsyncIterable<unknown>): AsyncIterable<unknown> {
        const span = { runId: call.run.runId, spanId: Bun.randomUUIDv7() }
        await opts.record("kernel:service:start", { use: call.use, method: call.method, kind: "stream", provider: call.provider.name }, span)
        let events = 0
        let ended = false
        try {
            for await (const answer of answers) {
                events++
                yield handles.given(call.use, call.provider, answer)
            }
            ended = true
            await opts.record("kernel:service:complete", { use: call.use, method: call.method, events: events }, span)
        } catch (cause) {
            ended = true
            const failure = refused(cause, call.use, call.method)
            await opts.record("kernel:service:failed", { use: call.use, method: call.method, error: failure }, span)
            throw failure
        } finally {
            // Its reader stopped before the end: a settled outcome, not a failure.
            if (!ended) await opts.record("kernel:service:interrupted", { use: call.use, method: call.method, events: events }, span)
        }
    }
}

export type ServicesT = ReturnType<typeof Services>

/** A provider's failure as the cognet sees it: its own code when it has one, SERVICE_FAILED when it does not. */
function refused(cause: unknown, use: string, method: string): AxonError {
    if (isAxonError(cause)) return cause
    return err("SERVICE_FAILED", { detail: `${use}.${method}: ${cause instanceof Error ? cause.message : String(cause)}`, cause: cause, context: { use: use, method: method } })
}

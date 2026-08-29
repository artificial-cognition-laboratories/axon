import { err } from "@arcforge/err"
import type { AxonBlueprint, AxonStimulusEntry } from "@arcforge/types"
import type { AgentServices } from "./agent"

/**
 * AgentRuntime — the confined agent's own half of the link.
 *
 * Adapts a live `Axon()` runtime to the four verbs a supervisor may invoke.
 * Deliberately thin: every verb is one delegation, because the runtime already
 * owns the behaviour and a second implementation here would be a place for the
 * two to disagree.
 *
 * What it does NOT do is as important. There is no `wake`: a supervisor emits a
 * STIMULUS and the brain decides whether to wake for it, which is the
 * scheduler's own admission policy. A `wake` verb would overrule that decision
 * from outside the mind it belongs to.
 */

/** The runtime surface this adapter needs — narrower than the whole AxonT. */
export type RuntimeForAgent = {
    kernel: {
        /** Deliver a stimulus. Throws RUN_IN_PROGRESS when the brain refuses one mid-wake. */
        request(input: { content?: string | string[]; channel?: string }): Promise<unknown>
        interrupt(reason: "user" | "shutdown"): void
        /** Execute code in the agent's scope, as the console/devtools eval does. */
        run(code: string, opts?: { origin?: string }): Promise<unknown>
    }
    /** The composed fetch handler — routes, middleware and plugins. Read per request, so a reload is picked up without rebinding. */
    server: { readonly handler: (request: Request) => Response | Promise<Response> }
    axon: {
        prompt(name: string, props?: Record<string, unknown>): Promise<unknown>
        prompts: {
            list(): unknown
            renderEntry(entry: unknown): Promise<unknown>
        }
    }
    update(partial: AxonBlueprint, opts?: { mode?: "merge" | "replace" }): Promise<unknown>
    shutdown(reason?: string): Promise<unknown>
}

/** How far `serve` walks forward from the requested port before giving up. */
const SERVE_ATTEMPTS = 20

export function AgentRuntime(runtime: RuntimeForAgent): AgentServices {
    /** The bound socket, once serve() has run. One per agent — serve is idempotent. */
    let bound: { port: number } | null = null

    return {
        /**
         * Deliver a stimulus and report ADMISSION.
         *
         * The wake is deliberately NOT awaited. Admission is the contract: a
         * continuous cognet ticks whether or not the last wake finished, so
         * waiting for completion here would serialise that overlap and turn a
         * mind under a clock into a queue.
         *
         * A refusal is a VERDICT, not a failure. `RUN_IN_PROGRESS` means an
         * invocation cognet is already holding its one conversation — the
         * mind's own admission policy answering — so it comes back as
         * `admitted: false` rather than an exception. Any other throw is a real
         * fault and propagates, because a stimulus that failed for an unknown
         * reason must not read as a polite refusal.
         */
        async stimulus(entry: AxonStimulusEntry): Promise<{ admitted: boolean }> {
            const { content, channel } = toRequestInput(entry)

            // Started, not awaited: the wake may run for minutes and admission
            // is the contract. What IS awaited is one microtask turn, which is
            // enough for the scheduler's synchronous reservation to reject —
            // `reserve()` throws RUN_IN_PROGRESS before any work begins.
            //
            // A Promise.race against an already-resolved promise cannot do
            // this: the resolved arm always wins, so a rejection arriving in
            // the same turn is never seen and every fault reads as admitted.
            // Settling into a promise instead keeps the value flowing through
            // a return, which is also the only shape TS can narrow.
            const settled = runtime.kernel.request({
                ...(content !== undefined ? { content } : {}),
                ...(channel !== undefined ? { channel } : {}),
            }).then(
                () => null,
                // The rejection is CONSUMED here, so a wake that fails long
                // after admission can never surface as an unhandled rejection
                // and take down the whole agent process.
                (cause: unknown) => ({ error: cause }),
            )

            // One turn. A wake still pending after it is genuinely running,
            // which is admission by definition.
            const immediate = await Promise.race([
                settled,
                Promise.resolve().then(() => "pending" as const),
            ])

            if (immediate !== "pending" && immediate !== null) {
                // Refusal is a VERDICT (the mind declining a second concurrent
                // conversation); anything else is a real fault and must not be
                // disguised as a polite "not now".
                if (isRefusal(immediate.error)) return { admitted: false }
                throw immediate.error
            }
            return { admitted: true }
        },

        update(blueprint: AxonBlueprint) {
            // Replace, not merge: the supervisor sends a fully re-normalised
            // blueprint, and merging it into the live one would let a removed
            // field survive a reload that deliberately dropped it.
            return runtime.update(blueprint, { mode: "replace" }).then(() => {})
        },

        interrupt(reason: "user" | "shutdown") {
            runtime.kernel.interrupt(reason)
        },

        shutdown() {
            return runtime.shutdown("supervisor").then(() => {})
        },

        /**
         * Deliver a stimulus and wait for its wake to SETTLE.
         *
         * The completion counterpart to `stimulus`. `kernel.request()` already
         * collects a wake and resolves when it is done, so this is the verb
         * that maps most directly — the work is in reporting the OUTCOME
         * rather than the entries, which reach the supervisor through commit
         * as they happen.
         *
         * An interrupt is a SETTLED outcome, not a failure: cancellation is
         * something the user did, and rendering it as an error would tell them
         * their agent broke when they are the one who stopped it.
         */
        async request(entry: AxonStimulusEntry): Promise<{ ok: boolean; interrupted?: boolean }> {
            const { content, channel } = toRequestInput(entry)
            try {
                await runtime.kernel.request({
                    ...(content !== undefined ? { content } : {}),
                    ...(channel !== undefined ? { channel } : {}),
                })
                return { ok: true }
            } catch (cause) {
                if (isInterrupt(cause)) return { ok: false, interrupted: true }
                // A refusal is not a completion — the wake never ran, so there
                // is nothing to report as settled. Surfaced as an ordinary
                // failure the caller sees rather than a quiet ok:false.
                throw cause
            }
        },

        /**
         * The console eval.
         *
         * `origin: "host"` marks it as a HUMAN's request rather than the
         * model's. Without that the timeline cannot tell a debugging eval from
         * something the agent decided to do — which would corrupt the record of
         * what it actually chose on its own.
         */
        run(code: string) {
            return runtime.kernel.run(code, { origin: "host" })
        },

        /**
         * Bind the agent's HTTP surface — in THIS process, where the routes
         * are.
         *
         * The handler is read per request through a closure rather than
         * captured: a reload rebuilds the server, and binding once to a
         * captured reference would keep serving the routes the author just
         * replaced.
         *
         * Walks forward when the port is taken, so a second agent on a
         * developer's machine comes up beside the first instead of failing.
         * The bound port goes back to the caller, which is the only honest
         * answer once walking is possible.
         */
        async serve(port: number): Promise<{ port: number }> {
            if (bound) return bound

            for (let candidate = port; candidate < port + SERVE_ATTEMPTS; candidate++) {
                try {
                    const started = Bun.serve({ port: candidate, fetch: request => runtime.server.handler(request) })
                    bound = { port: started.port ?? candidate }
                    return bound
                } catch (cause) {
                    // Only a taken port is worth walking past. Anything else
                    // (a permission denied, a malformed host) is a real fault
                    // and must not be retried into a confusing final error.
                    if (!isAddrInUse(cause)) throw cause
                }
            }

            throw err("AGENT_SERVE_NO_PORT", {
                detail: `no free port in ${port}–${port + SERVE_ATTEMPTS - 1}`,
                context: { from: port, attempts: SERVE_ATTEMPTS },
            })
        },

        prompts(request: { action: string; name?: string; entry?: unknown; props?: Record<string, unknown> }) {
            switch (request.action) {
                case "list": return Promise.resolve(runtime.axon.prompts.list())
                case "get": return runtime.axon.prompt(request.name!, request.props)
                case "render": return runtime.axon.prompts.renderEntry(request.entry)
                // Loud: an unknown action means the two sides disagree about
                // the contract, which silence would turn into an undefined the
                // caller renders as an empty prompt list.
                default: return Promise.reject(err("LINK_UNKNOWN_PROMPT_ACTION", { detail: request.action, context: { action: request.action } }))
            }
        },
    }
}

/**
 * A refusal the scheduler issued, as opposed to a fault.
 *
 * `RUN_IN_PROGRESS` is the one case: an invocation cognet IS one conversation,
 * so a second concurrent stimulus is the mind declining, not the runtime
 * breaking. Matched on the error CODE rather than the message, which is
 * presentation and free to change.
 */
/** A wake the user cancelled. Settled, never failed — see request(). */
function isInterrupt(cause: unknown): boolean {
    const code = (cause as { code?: string } | null)?.code
    if (typeof code === "string" && /INTERRUPT/i.test(code)) return true
    return cause instanceof Error && /interrupt|abort/i.test(cause.message)
}

function isRefusal(cause: unknown): boolean {
    const code = (cause as { code?: string } | null)?.code
    if (typeof code === "string" && code.includes("RUN_IN_PROGRESS")) return true
    return cause instanceof Error && /RUN_IN_PROGRESS/.test(cause.message)
}

/**
 * A stimulus entry as the kernel's request() wants it.
 *
 * Text stimuli carry content; a sensor reading does not. The kernel's input
 * shape is content-plus-channel, so anything without content is delivered as a
 * bare wake trigger rather than being forced into a text field it does not fit.
 */
function toRequestInput(entry: AxonStimulusEntry): { content?: string | string[]; channel?: string } {
    const data = (entry as { data?: { content?: unknown; channel?: unknown } }).data ?? {}
    const content = typeof data.content === "string" || Array.isArray(data.content) ? data.content : undefined
    const channel = typeof data.channel === "string" ? data.channel : undefined
    return {
        ...(content !== undefined ? { content: content as string | string[] } : {}),
        ...(channel !== undefined ? { channel } : {}),
    }
}

/** Bun.serve throws synchronously when the port is taken — match the address-in-use shape. */
function isAddrInUse(cause: unknown): boolean {
    const code = (cause as { code?: string })?.code
    const message = cause instanceof Error ? cause.message : String(cause)
    return code === "EADDRINUSE" || /address already in use|in use|EADDRINUSE/i.test(message)
}

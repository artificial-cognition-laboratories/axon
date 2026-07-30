import { err } from "@arcforge/err"
import type { AxonEntry, AxonStimulusEntry, CognetWake } from "@arcforge/types"
import { ENTRY_EVENT_PREFIXES } from "@arcforge/types"
import type { KernelBus } from "../contracts"
import type { AxonSessionT } from "@arcforge/session"
import type { KernelCognet } from "../contracts"

type WakeOpts = {
    cognet: KernelCognet
    stimuli: AxonStimulusEntry[]
    bus: KernelBus
    session: AxonSessionT
    abort: AbortController
}

/** Entry vocabulary — the families are defined WITH AxonEntryEvent, never duplicated here. */
function isEntry(event: unknown): event is AxonEntry {
    if (typeof event !== "object" || event === null) return false
    const e = event as { type?: string; id?: string }
    if (typeof e.type !== "string" || typeof e.id !== "string") return false
    return ENTRY_EVENT_PREFIXES.some(prefix => (e.type as string).startsWith(prefix))
}

/**
 * One execution of one wake: fires cognet.wake() exactly once and owns
 * everything around it — the run record (kernel:run:start/complete/failed/
 * interrupted) and the wire. Mode-agnostic — invocation.ts and continuous.ts
 * both invoke through this unchanged; neither trigger source is visible
 * here.
 *
 * The wire carries entries, full stop — forwarded from the bus (the commit
 * pipeline announces every commit after it's on disk); cognets are never
 * responsible for wire correctness of what they commit. There is no
 * transient/delta current anymore: a temporally-extended emission is
 * ordinary chunked entries (AxonChunk standard), so liveness rides the
 * same pipeline as durability.
 */
export function Wake(opts: WakeOpts) {
    const runId = Bun.randomUUIDv7()
    const abort = opts.abort
    const channel = Channel<AxonEntry>()
    const sessionCtx = { runId }

    // every durable commit reaches the wire, no cognet cooperation needed —
    // no thread to filter by, one session is always one continuous stream
    const unsubscribe = opts.bus.onAny((_type, payload) => {
        if (isEntry(payload)) channel.push(payload)
    })

    async function execute(): Promise<void> {
        const started = Date.now()

        // The outer try is the wire's terminal guarantee: no matter what
        // throws — including the run-record commits themselves (disk gone) —
        // the channel terminates and the bus subscription drops. Without it,
        // a failed commit escapes void execute() as an unhandled rejection
        // and the consumer's yield* hangs forever with the scheduler locked.
        try {
            await opts.session.commit("kernel:run:start", {}, sessionCtx)

            const wake: CognetWake = {
                stimuli: opts.stimuli,
                signal: abort.signal,
            }

            try {
                await opts.cognet.wake(wake)

                // cognets return early on abort; engines may also throw on it — both land as an interrupt
                if (abort.signal.aborted) {
                    await interrupted()
                } else {
                    await opts.session.commit("kernel:run:complete", { durationMs: Date.now() - started }, sessionCtx)
                }
                channel.close()
            } catch (cause) {
                if (abort.signal.aborted) {
                    await interrupted()
                    channel.close()
                    return
                }
                // err() already emitted this at its throw site (disk + live
                // sink → session's canonical "error" event) unless cause was
                // a raw, unwrapped throw — err(cause) covers that case too,
                // constructing+emitting for the first time. Either way this
                // commit is pure run-accounting, no error payload of its own.
                const failure = err(cause)
                opts.session.reportError(failure)
                await opts.session.commit("kernel:run:failed", { durationMs: Date.now() - started }, sessionCtx)
                channel.fail(failure)
            }
        } catch (cause) {
            channel.fail(err(cause))
        } finally {
            unsubscribe()
        }
    }

    async function interrupted(): Promise<void> {
        const reason = (abort.signal.reason ?? "user") as "user" | "shutdown"
        await opts.session.commitEntry("axon:interrupt", { reason }, { runId })
        await opts.session.commit("kernel:run:interrupted", { reason }, sessionCtx)
    }

    return {
        runId,
        abort,

        /** the wake's wire: durable entries, in commit order */
        async *stream(): AsyncGenerator<AxonEntry> {
            void execute() // failures surface through channel.fail → thrown at the consumer
            yield* channel
        },
    }
}

export type WakeT = ReturnType<typeof Wake>

// ── Channel ───────────────────────────────────────────────────────────────────

/**
 * Bridges the wake (which cannot yield) to the caller's async iterator.
 * push() during execution, close() on clean stop, fail() rethrows at the
 * consumer.
 */
function Channel<T>() {
    const buffer: T[] = []
    let notify: (() => void) | null = null
    let done = false
    let failed = false
    let failure: unknown = null

    function wakeConsumer() {
        notify?.()
        notify = null
    }

    return {
        push(value: T) {
            buffer.push(value)
            wakeConsumer()
        },
        close() {
            done = true
            wakeConsumer()
        },
        fail(cause: unknown) {
            failed = true
            failure = cause
            done = true
            wakeConsumer()
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<T> {
            while (true) {
                while (buffer.length > 0) yield buffer.shift()!
                if (done) {
                    if (failed) throw failure
                    return
                }
                await new Promise<void>((resolve) => { notify = resolve })
            }
        },
    }
}

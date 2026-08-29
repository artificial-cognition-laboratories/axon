import type { AxonTestEvent, AxonTestEventContext, AxonTestEventMap } from "@arcforge/types"

type EventsOpts = {
    /** Correlates every event in one run. */
    runId: string
    /**
     * Called in authoritative order, one at a time. A consumer that awaits is
     * awaited before the next event is delivered — the stream is a sequence,
     * and a subscriber must never see it interleaved.
     */
    onEvent?: (event: AxonTestEvent) => void | Promise<void>
}

/**
 * Events — the authoritative lifecycle stream of one test run.
 *
 * Owns three things a caller must never have to think about:
 *
 *   ordering    a monotonic sequence number, so events sort identically no
 *               matter how the transport reordered them
 *   liveness    which cases have started and not yet reported a terminal
 *               result, so a child that dies mid-test can be reconciled
 *   delivery    subscriber calls chained rather than fired in parallel
 *
 * Recording is synchronous and always succeeds. Delivery is deferred: a slow
 * subscriber must not stall the child process being watched, so `settle()` is
 * what a caller awaits once at the end.
 */
export function Events(opts: EventsOpts) {
    const collected: AxonTestEvent[] = []
    /** Cases that started and have not reported a terminal result, keyed by test + attempt. */
    const live = new Map<string, AxonTestEventContext>()

    let sequence = 0
    let delivery = Promise.resolve()

    function key(context: AxonTestEventContext): string {
        return `${context.testId}:${context.attempt ?? 0}`
    }

    return {
        /** Everything recorded so far, in authoritative order. */
        get all(): AxonTestEvent[] {
            return collected
        },

        record<K extends keyof AxonTestEventMap>(
            type: K,
            data: AxonTestEventMap[K],
            context: Omit<AxonTestEventContext, "testRunId"> = {},
        ): AxonTestEvent {
            const event = {
                id: Bun.randomUUIDv7(),
                type,
                time: { ms: Date.now(), seq: sequence++ },
                context: { testRunId: opts.runId, ...context },
                data,
            } as AxonTestEvent

            collected.push(event)

            if (event.context.testId) {
                if (type === "test:case:start") live.set(key(event.context), event.context)
                if (type === "test:case:pass" || type === "test:case:fail") live.delete(key(event.context))
            }

            if (opts.onEvent) {
                delivery = delivery.then(() => opts.onEvent!(event)).then(() => undefined)
            }
            return event
        },

        /** Cases from one file still awaiting a terminal result — the child died owing them an answer. */
        orphaned(file: string): AxonTestEventContext[] {
            return [...live.values()].filter(context => context.file === file)
        },

        /** How many cases reached each terminal state. */
        tally(): { passed: number; failed: number; skipped: number; todo: number } {
            const count = (type: string) => collected.filter(event => event.type === type).length
            return {
                passed: count("test:case:pass"),
                failed: count("test:case:fail"),
                skipped: count("test:case:skip"),
                todo: count("test:case:todo"),
            }
        },

        /** Whether a file reported any failure — a case or a hook. */
        failed(file: string): boolean {
            return collected.some(event => event.context.file === file
                && (event.type === "test:case:fail" || event.type === "test:hook:fail"))
        },

        /** Wait for every queued subscriber call to finish. Awaited once, at the end of a run. */
        async settle(): Promise<void> {
            await delivery
        },
    }
}

export type EventsT = ReturnType<typeof Events>

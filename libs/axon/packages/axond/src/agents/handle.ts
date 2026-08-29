import { err } from "@arcforge/err"
import type { AxonAgentHandle, AxonBlueprint, AxonEntry, AxonStimulusEntry } from "@arcforge/types"
import { Mirror } from "./mirror"
import type { Supervised } from "./supervise"

/**
 * The handle for an agent THIS process supervises.
 *
 * The `direct` transport of `AxonAgentHandle` — no wire, because the agent's
 * link is right here. It exists so the daemon's own internals, and any
 * consumer running inside it, speak the same contract a socket client does:
 * one interface, three transports, and no surface that works only when it
 * happens to be co-located.
 *
 * Every verb is a thin delegation to the link. What this adds is the SHAPE —
 * a mirrored session rather than the live one, and `stream` built from the
 * bus rather than exposed as a subscription.
 */
export function DirectHandle(live: Supervised): AxonAgentHandle {
    const session = Mirror({ session: live.session, bus: live.bus })

    return {
        sessionId: live.sessionId,

        stimulus(entry: AxonStimulusEntry) {
            return live.link.stimulus(entry)
        },

        request(entry: AxonStimulusEntry) {
            return live.link.request(entry)
        },

        /**
         * Deliver a stimulus and iterate what it produces.
         *
         * Built from the bus rather than from a streaming verb, because the
         * link has none: the agent commits, the supervisor's bus fans out, and
         * a consumer wanting a stream reads that. The request is issued
         * without awaiting so the caller can iterate while it runs — awaiting
         * first would yield nothing until the wake had already finished.
         */
        stream(entry: AxonStimulusEntry) {
            const queue: AxonEntry[] = []
            let push: (() => void) | null = null
            let done = false

            const stop = live.bus.onAny((type, data) => {
                queue.push({ type: type, data: data } as AxonEntry)
                push?.()
            })

            void live.link.request(entry).finally(() => {
                done = true
                push?.()
            })

            async function* iterate(): AsyncGenerator<AxonEntry, void, undefined> {
                try {
                    while (!done || queue.length > 0) {
                        const next = queue.shift()
                        if (next) {
                            yield next
                            continue
                        }
                        await new Promise<void>(resolve => { push = resolve })
                        push = null
                    }
                } finally {
                    // Unsubscribed however the loop leaves — a consumer that
                    // breaks early must not leave the bus feeding a queue
                    // nobody drains.
                    stop()
                }
            }

            return {
                stream: iterate(),
                interrupt: () => { live.link.interrupt("user") },
            }
        },

        async interrupt(reason: "user" | "shutdown") {
            live.link.interrupt(reason)
        },

        update(blueprint: AxonBlueprint) {
            return live.link.update(blueprint)
        },

        shutdown() {
            return live.stop()
        },

        session: session,

        async selectModel(_model: string) {
            // The supervisor holds the resolved roles, but rebinding one needs
            // a verb the link does not carry yet. Refused rather than silently
            // doing nothing — a picker that reported success and changed
            // nothing is worse than one that says it cannot.
            throw err("DAEMON_NOT_WIRED", {
                detail: "selectModel is not wired — the link carries no rebind verb yet",
                context: { sessionId: live.sessionId },
            })
        },
    }
}

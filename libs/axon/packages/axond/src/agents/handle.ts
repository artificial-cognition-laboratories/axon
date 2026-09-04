import { err } from "@arcforge/err"
import { isEntryEvent } from "@arcforge/types"
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
/**
 * Is this bus payload an entry envelope?
 *
 * `isEntryEvent` is the same predicate the runtime routes on, so this cannot
 * drift from what actually lands in `entries`. The shape check in front of it
 * is what keeps a raw capsule event — forwarded with its fields at the top
 * level and no `time` — from being yielded as an entry it is not.
 */
function isEntry(payload: unknown): payload is AxonEntry {
    if (!payload || typeof payload !== "object") return false
    const event = payload as { type?: unknown; time?: unknown }
    return typeof event.type === "string" && "time" in event && isEntryEvent(event.type)
}

export function DirectHandle(live: Supervised): AxonAgentHandle {
    const session = Mirror({ session: live.session, bus: live.bus })

    return {
        sessionId: live.sessionId,

        ingest(entry: AxonStimulusEntry) {
            return live.link.ingest(entry)
        },
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

            // The bus payload for a committed event IS the envelope
            // (`session.commit` announces via `bus.forward(event)`), and
            // AxonEntry IS that envelope shape. Rebuilding it as
            // `{ type, data }` wrapped an envelope inside a second one, so a
            // consumer reading `entry.data.content` got an object where the
            // contract promises a payload — the same double-wrap that once
            // crashed markdown rendering at the agent-main seam, kept alive
            // here by an `as` cast over the mismatch. Forwarded whole
            // instead, filtered to the entries this verb promises.
            const stop = live.bus.onAny((_type, payload) => {
                if (!isEntry(payload)) return
                queue.push(payload)
                push?.()
            })

            // `stream()` deliberately does not expose the request promise: its
            // consumer receives entries from the bus and only learns that the
            // wake ended when this iterator closes.  A link teardown is a
            // normal way for that request to reject (clear replaces the
            // session; an interrupt can win the same race).  `finally()`
            // creates a *new* promise that retains that rejection, so merely
            // prefixing it with `void` used to leave an AbortError unhandled
            // and let Bun put the whole TUI behind its runtime-error screen.
            //
            // The request's failure is already durable on the agent/session
            // path.  Here its only responsibility is closing this iterator.
            void live.link.request(entry)
                .finally(() => {
                    done = true
                    push?.()
                })
                .catch(() => {})

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

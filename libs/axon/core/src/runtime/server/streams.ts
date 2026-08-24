import type { setResponseHeader } from "h3"
import type { AxonEventView, AxonHandle, AxonSessionQuery } from "@arcforge/types"
import { classifyEvent } from "@arcforge/types"
import type { AxonBusT } from "../../platform"
import { frame, sseResponse } from "./sse"

/**
 * Streams — the two live wires the runtime serves.
 *
 * `runStream` is request-scoped: it follows ONE wake and closes when that
 * wake ends. `eventStream` is session-scoped: it carries everything happening
 * in the session, including between turns. Both are SSE, and both are built
 * here so the difference between them is the only thing either one states.
 */

type H3Event = Parameters<typeof setResponseHeader>[0]

/** Anything carrying the ordering counter — i.e. a real enveloped event. */
type Sequenced = { time: { seq: number } }

function isSequenced(payload: unknown): payload is Sequenced {
    if (typeof payload !== "object" || payload === null) return false
    const time = (payload as { time?: unknown }).time
    return typeof time === "object" && time !== null && typeof (time as { seq?: unknown }).seq === "number"
}

/**
 * Stream one wake's entries to the client.
 *
 * A terminal `event: done` frame closes the stream cleanly so the client knows
 * the run finished rather than the socket dropping. A mid-stream failure emits
 * an `event: error` frame before closing — the client must be able to tell
 * "completed" from "broke".
 */
export function runStream(event: H3Event, run: ReturnType<AxonHandle["stream"]>): Response {
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const entry of run.stream) {
                    controller.enqueue(frame(entry))
                }
                controller.enqueue(frame({}, { event: "done" }))
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause)
                controller.enqueue(frame({ message }, { event: "error" }))
            } finally {
                controller.close()
            }
        },
        cancel() {
            // Client disconnected — cancel the underlying wake so the agent
            // stops working on a response nobody is listening for.
            run.interrupt()
        },
    })

    return sseResponse(event, body)
}

type EventStreamOpts = {
    bus: AxonBusT
    session: AxonHandle["session"]
    query: AxonSessionQuery
}

/**
 * Bridge the runtime bus to SSE, replaying history first.
 *
 * Replay-then-live is what makes reconnection trivial: a client passes the
 * cursor it already has, gets the gap from the session log, and continues into
 * the live feed with no separate hydrate call and no window where events fall
 * between the two. The subscription is attached BEFORE the replay is written,
 * and live events arriving during replay are buffered rather than dropped —
 * otherwise the gap this endpoint exists to close would reopen inside it.
 *
 * Every frame carries `id: <seq>`, so a browser's EventSource reconnect sends
 * `Last-Event-ID` and resumes exactly where it left off for free.
 */
export function eventStream(event: H3Event, opts: EventStreamOpts): Response {
    const { bus, session, query } = opts
    const { include, since } = query

    function wanted(view: AxonEventView): boolean {
        return include === undefined || include.includes(view)
    }

    let unsubscribe: (() => void) | null = null

    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            let live = false
            const pending: Sequenced[] = []

            // Subscribe first. Anything emitted while the replay is being
            // written lands in `pending` and is flushed after it, in order.
            unsubscribe = bus.onAny((type, payload) => {
                if (!isSequenced(payload)) return // transient bus traffic with no envelope
                if (!wanted(classifyEvent(type))) return
                if (live) controller.enqueue(frame(payload, { id: payload.time.seq }))
                else pending.push(payload)
            })

            const history = [
                ...(wanted("entries") ? session.entries : []),
                ...(wanted("log") ? session.log : []),
                ...(wanted("kernelLog") ? session.kernelLog : []),
            ]
                .filter(item => since === undefined || item.time.seq > since)
                .sort((a, b) => a.time.seq - b.time.seq)

            const replay = query.limit !== undefined ? history.slice(-query.limit) : history
            for (const item of replay) controller.enqueue(frame(item, { id: item.time.seq }))

            // Tell the client where replay ended, so it can distinguish
            // "caught up" from "still receiving history" — a UI showing a
            // loading state needs that edge.
            const cursor = replay.at(-1)?.time.seq ?? since ?? null
            controller.enqueue(frame({ cursor }, { event: "live" }))

            // Flush anything that arrived mid-replay, skipping what replay
            // already covered, then go live.
            const highWater = replay.at(-1)?.time.seq ?? -1
            for (const item of pending) {
                if (item.time.seq > highWater) controller.enqueue(frame(item, { id: item.time.seq }))
            }
            pending.length = 0
            live = true
        },
        cancel() {
            unsubscribe?.()
            unsubscribe = null
        },
    })

    return sseResponse(event, body)
}

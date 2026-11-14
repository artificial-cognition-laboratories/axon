import { addressedTo, type AxonConnection, type AxonOutputEvent } from "@arcforge/types"
import type { AxonKernelT } from "@arcforge/kernel"
import type { AxonBusT } from "../platform"

/**
 * Connections — clients talking to the running mind, each at its own address.
 *
 * A connection is the mind's sense door and its outputs, scoped to one
 * client: what it sends arrives as a stimulus on its channel, and it hears
 * what the mind addresses to that channel, or to no one. Nothing waits for an
 * answer to end — a mind may answer, keep working, or speak unprompted, and a
 * client renders whatever arrives.
 */
export function Connections(opts: { kernel: AxonKernelT; bus: AxonBusT }) {
    return {
        open(at: { channel: string }): AxonConnection {
            return {
                send: content => opts.kernel.ingest({ content: content, channel: at.channel }),

                on: (type, handler) => opts.bus.onAny(async (event: string, payload: unknown) => {
                    if (event !== type) return
                    const data = fact(payload) as AxonOutputEvent[typeof type]
                    if (!addressedTo(data, at.channel)) return
                    await handler(data)
                }),

                activity: handler => opts.bus.onAny((event: string, payload: unknown) => {
                    if (event !== "cognet:activity") return
                    handler((fact(payload) as { working: string[] }).working)
                }),

                interrupt: () => opts.kernel.interrupt("user"),
            }
        },
    }
}

export type ConnectionsT = ReturnType<typeof Connections>

/** The bus carries whole envelopes; a client wants the fact inside. */
function fact(payload: unknown): unknown {
    return (payload as { data?: unknown }).data ?? payload
}

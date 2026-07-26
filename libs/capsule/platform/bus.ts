import type { AnyCapsuleEvent, CapsuleEvent, CapsuleEventName } from "../types"

type Handler<K extends CapsuleEventName> = (data: CapsuleEvent[K]) => void

/**
 * CapsuleBus — the capsule's observation surface. Lifetime: the capsule.
 *
 * Subscriptions survive subprocess restarts — the wire of each incarnation
 * attaches to this same bus. The capsule is the single writer: emit is
 * package-internal, only on/once/off are exposed on the handle.
 */
export function CapsuleBus() {
    const handlers = new Map<CapsuleEventName, Set<Handler<any>>>()

    function on<K extends CapsuleEventName>(type: K, handler: Handler<K>): () => void {
        let set = handlers.get(type)
        if (!set) {
            set = new Set()
            handlers.set(type, set)
        }
        set.add(handler)
        return () => set!.delete(handler)
    }

    const anyHandlers = new Set<(event: AnyCapsuleEvent) => void>()

    return {
        emit<K extends CapsuleEventName>(type: K, data: CapsuleEvent[K]) {
            const set = handlers.get(type)
            // A throwing subscriber is a bug in the subscriber — it propagates.
            if (set) for (const handler of [...set]) handler(data)
            for (const handler of [...anyHandlers]) handler({ type, ...data } as AnyCapsuleEvent)
        },

        on,

        /** Subscribe to every event — the relay primitive for hosts forwarding the stream. */
        onAny(handler: (event: AnyCapsuleEvent) => void): () => void {
            anyHandlers.add(handler)
            return () => { anyHandlers.delete(handler) }
        },

        once<K extends CapsuleEventName>(type: K, handler: Handler<K>): () => void {
            const off = on(type, data => {
                off()
                handler(data)
            })
            return off
        },

        off<K extends CapsuleEventName>(type: K, handler: Handler<K>) {
            handlers.get(type)?.delete(handler)
        },
    }
}

export type CapsuleBusT = ReturnType<typeof CapsuleBus>

import type { CapsuleCommand, CapsuleEventName, CapsuleEvent } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"

/**
 * The in-process replacement for the wire.
 *
 * `Runner`, `Scope`, `Procs` and the rest were written against a `wire.emit()`
 * that serialised to stdout and a `wire.onCommand()` that read stdin. None of
 * that logic was ABOUT the boundary — it was about announcing what happened
 * and being told what to do — so the machinery moves unchanged and only this
 * shim changes underneath it.
 *
 * `emit` goes straight to the bus the manager already owns. `onCommand` has no
 * caller left: commands used to arrive over stdin because the guest could not
 * be called directly, and in one heap the manager simply calls the function.
 * It stays on the shape so the ported files compile untouched, and it throws
 * rather than silently accepting a subscription nobody will ever serve.
 */
/**
 * The shape every leaf writes against.
 *
 * Named `SandboxWireT` historically, when it WAS a wire to a subprocess. The
 * leaves — runner, scope, procs, mediator, console, activities — all take one
 * of these and none of them cares what is behind it, which is exactly why they
 * ported unchanged. This is now the only implementation.
 */
export type InProcWireT = {
    emit<K extends CapsuleEventName>(type: K, data: CapsuleEvent[K]): void
    onCommand(handler: (cmd: CapsuleCommand) => void): () => void
    /** Route one command to every registered handler — the in-heap `send`. */
    deliver(command: unknown): void
}

export function InProcWire(bus: CapsuleBusT): InProcWireT {
    const handlers = new Set<(cmd: unknown) => void>()

    return {
        emit(type, data) {
            bus.emit(type, data)
        },

        /**
         * Register an inbound-command handler.
         *
         * Kept, and kept HARMLESS. Several leaves subscribe for their own
         * reasons — the mediator waits for a `policy:response`, the scope for
         * `tool:load` — and in one heap those arrive as direct calls instead.
         * The subscription is therefore a no-op rather than an error: throwing
         * here punished a leaf for a shape it inherited, and the leaves that
         * genuinely need calling are given explicit verbs (Runner.run,
         * Scope.load, Mediator.answer).
         *
         * Handlers are still recorded, so `deliver` can hand a command to them
         * when a manager does have one to route.
         */
        onCommand(handler: (cmd: CapsuleCommand) => void): () => void {
            handlers.add(handler as (cmd: unknown) => void)
            return () => handlers.delete(handler as (cmd: unknown) => void)
        },

        /** Route one command to every registered handler — the in-heap `send`. */
        deliver(command: unknown): void {
            for (const handler of [...handlers]) handler(command)
        },
    }
}

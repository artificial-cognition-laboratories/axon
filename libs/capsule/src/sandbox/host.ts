import { err } from "@axon/err"
import type { CapsuleCommand, CapsuleHost } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"

type HostOpts = {
    send(command: CapsuleCommand): void
    bus: CapsuleBusT
    host?: CapsuleHost
}

/** Host-side dispatcher for requests emitted by the capsule Axon facade. */
export function Host(opts: HostOpts) {
    const active = new Map<string, { commandId: string | null; controller: AbortController }>()

    opts.bus.on("capsule:host:request", request => {
        const controller = new AbortController()
        active.set(request.id, { commandId: request.commandId, controller })

        const call = opts.host
            ? opts.host.call({ method: request.method, input: request.input, signal: controller.signal })
            : Promise.reject(err("CAPSULE_HOST_UNAVAILABLE", { context: { reason: "no host service provider", method: request.method } }))

        void call
            .then(result => respond({ type: "host:response", id: request.id, result }))
            .catch(cause => respond({
                type: "host:response", id: request.id,
                error: cause instanceof Error ? cause.message : String(cause),
            }))
            .finally(() => active.delete(request.id))
    })

    function respond(command: CapsuleCommand): void {
        // The originating command may have hard-killed its incarnation while
        // the host operation was unwinding. There is then nobody to answer.
        try { opts.send(command) } catch { /* dead capsule — cancellation owns cleanup */ }
    }

    opts.bus.on("capsule:cmd:interrupt:requested", event => {
        for (const request of active.values()) {
            if (request.commandId === event.id) request.controller.abort()
        }
    })

    opts.bus.on("capsule:exit", () => {
        for (const request of active.values()) request.controller.abort()
        active.clear()
    })
}

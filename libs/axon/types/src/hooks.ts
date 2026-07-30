import type { EventHandler as H3EventHandler } from "h3"

/**
 * Runtime lifecycle hooks — Nitro/Nuxt-style call points the runtime itself
 * awaits at fixed points during boot, request handling, and shutdown.
 *
 * Distinct from the event bus (`axon.on`/`axon.emit`): the bus is many-to-many
 * fire-and-forget notification for module/domain events (`github:issue.opened`).
 * These are one call point, in-order, awaited-to-completion — the runtime
 * pauses here for every registered handler before continuing. Registered via
 * `axon.hooks.hook(name, fn)` in `server/plugins/*.ts`; fired by the runtime,
 * never by agent code.
 *
 * Add a call point here first — the type is the contract; Axon()/AxonServer()
 * fire what's declared, nothing more.
 */
export type AxonHooks = {
    /** Runtime finished assembling — kernel, handle, and server are all live. */
    "boot:after": () => void | Promise<void>

    /** Fires once per incoming request, before the route handler runs. */
    "request:before": H3EventHandler

    /** Fires once per completed request, after the route handler resolved. */
    "request:after": H3EventHandler

    /** Runtime teardown has started — kernel/capsule/session are still alive. */
    "shutdown:before": () => void | Promise<void>
}

export type AxonHookName = keyof AxonHooks

/**
 * Module event payloads — an OPEN interface, augmented per-agent by typegen.
 *
 * A module declares `emits: { "discord:message.received": {} as { ... } }`;
 * `axon prepare` merges each installed module's emit payloads into this
 * interface (declaration merging, in `.agent/axon.d.ts`). That makes
 * `axon.hooks.hook("discord:message.received", ({ content }) => ...)` fully
 * typed in userland — the event name autocompletes and the payload is inferred
 * — with no imports and no generics.
 *
 * Distinct from AxonHooks: those are the fixed runtime lifecycle call points
 * (a closed set, function-typed). Module events are domain events with a
 * payload the handler receives; the name space is open because it depends on
 * which modules the agent installed.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AxonModuleEvents {}

export type AxonModuleEventName = keyof AxonModuleEvents

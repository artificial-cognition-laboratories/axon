/**
 * Platform — the runtime's shared infrastructure.
 *
 * Everything here is constructed once at the Axon() seam and handed to
 * whoever needs it: the event bus, the lifecycle hooks, the blueprint
 * normalizer, the global injector, boot-time identity rendering. None of it
 * knows about cognition, execution, or HTTP — those layers depend on this
 * one, never the reverse.
 *
 * This index IS the boundary. Import from `../platform`, never from
 * `../platform/bus` or any other file inside: reaching past it means either
 * the thing belongs in this list or it should not be reached at all.
 */
export { AxonBus, type AxonBusT, type BusHistoryEntry, type EventHandler } from "./bus"
export { Hooks, type AxonHooksT } from "./hooks"
export { AxonBlueprint, mergeBlueprint } from "./blueprint"
export { Inject } from "./inject"
export { Boot } from "./boot"

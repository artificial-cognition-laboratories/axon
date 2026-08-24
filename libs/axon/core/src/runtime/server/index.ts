/**
 * Server — the agent's HTTP surface.
 *
 * AxonServer() is the only thing outside this folder should reach for; the
 * appliers (middleware, plugins, routes), the reserved /_axon endpoints, and
 * the SSE machinery are its internals.
 */
export { AxonServer } from "./server"

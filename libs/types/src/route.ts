import type { EventHandler } from "h3"

/** HTTP or WebSocket route discovered from `server/api/`. */
export type AxonRoute = {
    /** HTTP method or WebSocket marker. */
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY" | "WS"
    /** Route path, for example `/api/users` or `/api/users/[id]`. */
    path: string
    /** Resolved h3 handler — loaded by the CLI, mounted as-is by the runtime. */
    handler: EventHandler
    /** Source file that produced this route. */
    file?: string
    /** Whether the route requires server auth. */
    auth?: boolean
}

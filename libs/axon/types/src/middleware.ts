import type { EventHandler } from "h3"

/** Server middleware entry — pre-resolved and pre-ordered by the CLI. */
export type AxonMiddleware = {
    name: string
    handler: EventHandler
}

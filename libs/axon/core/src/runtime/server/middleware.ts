import { createApp } from "h3"
import type { AxonMiddleware } from "@arcforge/types"

type MiddlewareOpts = {
    h3: ReturnType<typeof createApp>
    entries: AxonMiddleware[]
}

/** Applies pre-resolved, pre-ordered middleware. No discovery, no conflict resolution. */
export function Middleware(opts: MiddlewareOpts) {
    for (const entry of opts.entries) {
        opts.h3.use(entry.handler)
    }

    return {
        registered: opts.entries.map(e => e.name),
    }
}

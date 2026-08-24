import { createApp, defineEventHandler, createError } from "h3"
import type { AxonMiddleware } from "@arcforge/types"

type MiddlewareOpts = {
    h3: ReturnType<typeof createApp>
    entries: AxonMiddleware[]
}

/**
 * Applies pre-resolved, pre-ordered middleware. No discovery, no conflict
 * resolution.
 *
 * ── A middleware that failed to load BLOCKS, it does not vanish ─────────────
 *
 * An entry carrying `failed` is one a module shipped that would not load. It
 * is replaced with a handler that refuses every request rather than dropped
 * from the chain — the single most dangerous degradation available here would
 * be to skip it, because middleware commonly carries auth and validation and a
 * skipped one is a request path running without the checks its author wrote.
 *
 * That is a security hole wearing the costume of a working server, and it is
 * exactly the failure mode a reverse proxy exists to prevent: nginx answers
 * 502 for a backend it cannot reach, it does not serve the request without it.
 *
 * The agent is unaffected — it boots, thinks and replies. Only the HTTP
 * surface fails closed, because only the HTTP surface was guarded.
 */
export function Middleware(opts: MiddlewareOpts) {
    for (const entry of opts.entries) {
        if (entry.failed !== undefined) {
            opts.h3.use(defineEventHandler(() => {
                throw createError({
                    statusCode: 503,
                    statusMessage: "Middleware Unavailable",
                    // The reason goes in `data`, not `message`: h3 strips
                    // `message` outside dev to avoid leaking internals, and a
                    // bare 503 sends the reader looking at the route instead of
                    // at the guard that did not load.
                    //
                    // Naming it is not a leak worth avoiding — whoever receives
                    // this is the operator of the agent that failed to boot its
                    // own middleware, and they are the only person who can fix
                    // it.
                    data: {
                        middleware: entry.name,
                        reason: entry.failed,
                    },
                })
            }))
            continue
        }
        if (entry.handler) opts.h3.use(entry.handler)
    }

    return {
        registered: opts.entries.filter(e => e.failed === undefined).map(e => e.name),
        blocked: opts.entries.filter(e => e.failed !== undefined).map(e => e.name),
    }
}

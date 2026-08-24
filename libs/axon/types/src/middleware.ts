import type { EventHandler } from "h3"

/** Server middleware entry — pre-resolved and pre-ordered by the CLI. */
export type AxonMiddleware = {
    name: string
    /** Absent when the middleware failed to load — see `failed`. */
    handler?: EventHandler
    /**
     * Why this middleware could not be loaded.
     *
     * Set only for a MODULE's middleware, which degrades rather than crashing
     * the agent. It is kept in the chain rather than dropped, and the runtime
     * replaces it with a handler that refuses every request.
     *
     * Dropping it would be the one genuinely dangerous degradation in the
     * system: middleware commonly carries auth and validation, so a skipped
     * one is a request path running without the checks its author wrote — a
     * security hole that looks like a working server. Failing closed is the
     * same posture a reverse proxy takes for a backend it cannot reach.
     */
    failed?: string
}

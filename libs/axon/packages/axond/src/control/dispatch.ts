import { err } from "@arcforge/err"

type DispatchOpts = {
    /**
     * What a verb path resolves against.
     *
     * A bag rather than the root itself: what is reachable here is reachable
     * BY A CLIENT, and handing over `Axond()` would put the lifecycle and the
     * server inside the surface a socket can walk.
     */
    domains: Record<string, unknown>
}

/**
 * Dispatch — resolve a verb path against the domains and call it.
 *
 * The one piece of logic between the socket and a domain, and it belongs to
 * `control/` rather than to the root: the root wires, and a path-walking loop
 * with two throw sites is not wiring. Owning it here also means the transport
 * tests exercise the real resolver rather than a copy of it.
 *
 * Every failure past resolution is the DOMAIN'S own error, thrown from the
 * domain — so a client sees exactly the code a local caller would, and the
 * wire adds nothing to it.
 */
export function Dispatch(opts: DispatchOpts) {
    return async function dispatch(path: readonly string[], arg: unknown): Promise<unknown> {
        let target: unknown = opts.domains
        /**
         * What `target` was reached THROUGH, kept so the call below can be a
         * method call rather than a bare one.
         *
         * A verb that calls a sibling — `models.fetch` calling `refresh`, or
         * `agents.state` calling `list` — reads it off `this`, which is the
         * domain when a local caller writes `models.fetch(...)`. Walking to
         * the function and invoking it detached loses that: `this` is
         * undefined and the sibling throws, so a verb that works in-process
         * fails only over the socket. Carrying the owner makes the two call
         * paths identical.
         */
        let owner: unknown = undefined

        for (const segment of path) {
            if (typeof target !== "object" || target === null || !(segment in target)) {
                throw err("DAEMON_NOT_WIRED", {
                    detail: `no such verb: ${path.join(".")}`,
                    context: { path: path.join(".") },
                })
            }
            owner = target
            target = (target as Record<string, unknown>)[segment]
        }

        if (typeof target !== "function") {
            throw err("DAEMON_NOT_WIRED", {
                detail: `${path.join(".")} is not callable`,
                context: { path: path.join(".") },
            })
        }

        return (target as (this: unknown, input: unknown) => unknown).call(owner, arg)
    }
}

export type DispatchT = ReturnType<typeof Dispatch>

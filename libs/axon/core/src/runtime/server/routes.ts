import { createRouter } from "h3"
import type { AxonRoute } from "@arcforge/types"
import { H3T } from "./h3"

type RoutesOpts = {
    h3: H3T
    entries: AxonRoute[]
}

/**
 * Mounts agent-owned routes onto the router. These are the routes that
 * already won any conflict against module routes upstream — always
 * mounted, never skipped.
 */
export function Routes(opts: RoutesOpts) {
    const h3 = opts.h3

    for (const route of opts.entries) {
        mountRoute(h3.router, route)
    }

    return {
        mounted: opts.entries.map(r => `${r.method} ${r.path}`),
    }
}

export function mountRoute(router: ReturnType<typeof createRouter>, route: AxonRoute) {
    if (route.method === "WS" || route.method === "ANY") {
        router.use(route.path, route.handler)
        return
    }
    router[route.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete"](route.path, route.handler)
}

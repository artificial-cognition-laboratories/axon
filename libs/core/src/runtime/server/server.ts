import { Endpoints } from "./endpoints"
import { H3 } from "./h3"
import { Middleware } from "./middleware"
import { Plugins } from "./plugins"
import { Routes } from "./routes"
import type { AxonBlueprint, AxonHandle } from "@arcforge/types"
import { AxonHooksT } from "../../platform/hooks"

type ServerOpts = {
    blueprint: AxonBlueprint
    hooks: AxonHooksT
    /** The runtime handle, forwarded to each server plugin's fn — passed, never global. */
    axon: AxonHandle
}

/**
 * Axon Server factory.
 *
 * Everything here is a pure applier — the blueprint arrives fully resolved
 * (conflict resolution, ordering, discovery, and module merging all happened
 * upstream in the CLI/manifest build step). There is no module-specific
 * mounting step here — module routes are already merged into
 * blueprint.server.routes. Order below matters:
 *   env -> middleware -> plugins (pre-route hook) -> routes
 *
 * @orchestrator - this should not contain low level logic
 * @behaviour - all error handling should exist in lower layers
 */
export async function AxonServer(opts: ServerOpts) {
    const h3 = H3()

    // framework-level hook point — ahead of user middleware, so request:before
    // observes every request regardless of what user middleware does with it
    h3.app.use((event) => opts.hooks.callHook("request:before", event))

    const middleware = Middleware({
        h3: h3.app,
        entries: opts.blueprint.server.middleware,
    })

    // AxonServer() is rebuilt whole on every reload, and Plugins() reruns in
    // full — reset first or a plugin's hook.hook() calls accumulate one extra
    // registration per reload (same handler firing N times for one event).
    opts.hooks.reset()

    await Plugins({
        entries: opts.blueprint.server.plugins,
        axon: opts.axon,
    })

    // Framework-reserved /_axon/* surface — mounted BEFORE user routes so it
    // is always present and can never be shadowed. This is the normalized wire
    // contract AxonCloud.attach() speaks to, independent of authored routes.
    const endpoints = Endpoints({
        h3: h3,
        axon: opts.axon,
        blueprint: opts.blueprint,
    })

    const routes = Routes({
        h3: h3,
        entries: opts.blueprint.server.routes,
    })

    // request:after must run once the route handler has actually resolved —
    // h3's layer stack is sequential, not onion-style, so this can't be a
    // plain .use() registered before the router (that would fire alongside
    // request:before, ahead of the route). Wrap the router's own handler instead.
    h3.mount(async (event) => {
        const response = await h3.router.handler(event)
        await opts.hooks.callHook("request:after", event)
        return response
    })

    return {
        middleware: middleware,
        endpoints: endpoints,
        routes: routes,
        /** Web-standard fetch handler — bind it to a port with Bun.serve or any web-fetch runtime. */
        handler: h3.toFetchHandler(),
    }
}

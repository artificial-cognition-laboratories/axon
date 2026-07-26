import { createApp, createRouter, toWebHandler, EventHandler } from "h3"

/**
 * Owns everything h3-specific: app/router construction, mounting the
 * router onto the app, and serving. Middleware/Modules/Routes/Plugins
 * only ever touch the `app`/`router` handles this hands them — they
 * never construct or serve h3 themselves.
 */
export function H3() {
    const app = createApp()
    const router = createRouter()

    return {
        app,
        router,

        /**
         * Mount onto the app — call once, after all routes/middleware are
         * registered. Defaults to the bare router; pass a wrapping handler
         * to observe the router's resolution (e.g. request:after, which
         * must run once the route handler has actually resolved).
         */
        mount(handler: EventHandler = router.handler) {
            app.use(handler)
        },

        /** convert to a web-standard fetch handler for Bun.serve or any web-fetch runtime */
        toFetchHandler() {
            return toWebHandler(app)
        },
    }
}
export type H3T = ReturnType<typeof H3>
import * as h3 from "h3"

/**
 * The h3 utility surface auto-imported into agent server files — routes,
 * middleware, and server plugins. Agent authors never import h3, exactly as
 * Nitro users never do: same names, same behavior, no shims. These ARE the
 * real h3 implementations.
 *
 * ONE list, three consumers: routes.ts and middleware.ts install it at scan
 * time, and typegen/axon-dts.ts declares it into .agent/axon.d.ts. They had
 * drifted apart — the .d.ts declared ~25 helpers while the runtime installed
 * 6, so `setHeader`/`sendStream`/`getCookie` and friends typechecked cleanly
 * and threw ReferenceError the moment a route ran. A single exported list is
 * what makes that class of bug unrepresentable: adding a name here reaches
 * the runtime and the types in the same edit.
 *
 * Mirrors Nitro's auto-import set (h3's public utilities, minus the app/
 * router construction functions an agent author has no business calling —
 * Axon owns the app and the router).
 */
export const H3_GLOBALS = [
    // ── Event handler API ────────────────────────────────────────────────
    "defineEventHandler",
    "defineLazyEventHandler",
    "defineWebSocketHandler",
    "defineRequestMiddleware",
    "defineResponseMiddleware",
    "eventHandler",
    "lazyEventHandler",
    "dynamicEventHandler",
    "isEvent",
    "isEventHandler",
    "toEventHandler",

    // ── Request ──────────────────────────────────────────────────────────
    "readBody",
    "readValidatedBody",
    "readRawBody",
    "readFormData",
    "readMultipartFormData",
    "getQuery",
    "getValidatedQuery",
    "getRouterParam",
    "getRouterParams",
    "getValidatedRouterParams",
    "getMethod",
    "isMethod",
    "assertMethod",
    "getRequestURL",
    "getRequestHost",
    "getRequestIP",
    "getRequestPath",
    "getRequestProtocol",
    "getRequestFingerprint",
    "getRequestWebStream",
    "toWebRequest",

    // ── Headers ──────────────────────────────────────────────────────────
    "getHeader",
    "getHeaders",
    "getRequestHeader",
    "getRequestHeaders",
    "setHeader",
    "setHeaders",
    "appendHeader",
    "appendHeaders",
    "getResponseHeader",
    "getResponseHeaders",
    "setResponseHeader",
    "setResponseHeaders",
    "appendResponseHeader",
    "appendResponseHeaders",
    "removeResponseHeader",
    "clearResponseHeaders",

    // ── Cookies & sessions ───────────────────────────────────────────────
    "getCookie",
    "setCookie",
    "deleteCookie",
    "parseCookies",
    "splitCookiesString",
    "useSession",
    "getSession",
    "updateSession",
    "clearSession",
    "sealSession",
    "unsealSession",

    // ── Response ─────────────────────────────────────────────────────────
    "send",
    "sendNoContent",
    "sendRedirect",
    "sendStream",
    "sendIterable",
    "sendWebResponse",
    "sendError",
    "sendProxy",
    "proxyRequest",
    "fetchWithEvent",
    "getProxyRequestHeaders",
    "setResponseStatus",
    "getResponseStatus",
    "getResponseStatusText",
    "defaultContentType",
    "isStream",
    "isWebResponse",
    "writeEarlyHints",
    "serveStatic",

    // ── Server-sent events ───────────────────────────────────────────────
    "createEventStream",

    // ── Errors ───────────────────────────────────────────────────────────
    "createError",
    "isError",
    "sanitizeStatusCode",
    "sanitizeStatusMessage",

    // ── CORS ─────────────────────────────────────────────────────────────
    "handleCors",
    "appendCorsHeaders",
    "appendCorsPreflightHeaders",
    "isPreflightRequest",
    "isCorsOriginAllowed",
] as const satisfies readonly (keyof typeof h3)[]

/**
 * Install the h3 surface onto globalThis. Idempotent (`??=`) and safe to call
 * from every scanner — routes and middleware both run it before importing
 * author files, and a module's scan runs it again per module root.
 */
export function installH3Globals(): void {
    const g = globalThis as Record<string, unknown>
    for (const name of H3_GLOBALS) {
        g[name] ??= h3[name]
    }
}

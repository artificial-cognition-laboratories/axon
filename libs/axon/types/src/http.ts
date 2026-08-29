/**
 * HTTP error contract shared across the Axon stack.
 *
 * Lives in @arcforge/types (not @arcforge/cloud) because it is a wire contract:
 * engines, cloud transport, and CLI publish/deploy flows all branch on
 * `err.code` / `err.data`. @arcforge/cloud re-exports it so existing internal
 * imports keep working; @arcforge/engines depends on it directly so it can be
 * published to npm without pulling in internal cloud transport.
 */

export type HttpErrorCode =
    | "AUTH_REQUIRED"       // no key available when one was required
    | "AUTH_EXPIRED"        // 401
    | "FORBIDDEN"           // 403
    | "NOT_FOUND"           // 404
    | "CONFLICT"            // 409
    | "PAYLOAD_TOO_LARGE"   // 413
    | "RATE_LIMITED"        // 429
    | "SERVICE_UNAVAILABLE" // 503
    | "SERVER_ERROR"        // other 5xx / unclassified

export function classifyStatus(status: number): HttpErrorCode {
    switch (status) {
        case 401: return "AUTH_EXPIRED"
        case 403: return "FORBIDDEN"
        case 404: return "NOT_FOUND"
        case 409: return "CONFLICT"
        case 413: return "PAYLOAD_TOO_LARGE"
        case 429: return "RATE_LIMITED"
        case 503: return "SERVICE_UNAVAILABLE"
        default: return "SERVER_ERROR"
    }
}

export class HttpError extends Error {
    code: HttpErrorCode
    status: number
    path: string
    /** Structured error body from the backend (h3 createError `data`), when present. */
    data?: Record<string, unknown>

    constructor(status: number, path: string, message?: string, data?: Record<string, unknown>) {
        super(message ?? `request to ${path} failed with status ${status}`)
        this.code = classifyStatus(status)
        this.status = status
        this.path = path
        if (data) this.data = data
    }
}

import { trace } from "./trace"
import { HttpError, classifyStatus } from "@arcforge/types"
import type { HttpErrorCode } from "@arcforge/types"

// HttpError is a wire contract shared across the stack — it lives in
// @arcforge/types (so @arcforge/engines can depend on it without pulling in cloud
// transport). It's imported above for this module's OWN use (Http()/parseError
// construct it) and re-exported below so existing @arcforge/cloud consumers keep
// resolving it from the same place. A bare `export { HttpError } from ...`
// forwards the name to consumers but creates NO local binding, which is why
// `new HttpError(...)` here was a ReferenceError — the re-export must go through
// a real local import.
export { HttpError, classifyStatus }
export type { HttpErrorCode }

/**
 * Default backend target, resolved once at module load:
 *   1. AXON_API_BASE — explicit override, what every test in this package
 *      sets to point at its staging daemon.
 *   2. AXON_STAGING_MODE=true — convenience flag (same one the backend
 *      itself reads to swap its storage/deployments backends — see
 *      apps/backend/platform/gcloud/gcloud.ts) for a bare `http://localhost:3099`
 *      with no explicit URL needed.
 *   3. Otherwise, production.
 * The one place "what do we talk to by default" lives, so no consumer (TUI,
 * CLI, scripts) needs its own env-detection to get local staging for free.
 */
export const PRODUCTION_API_BASE = "https://axon-api-t53zrgvpga-ew.a.run.app"

/** Resolve the backend target without coupling CLI consumers to the website host. */
export function resolveDefaultBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env) {
    return env.AXON_API_BASE ??
        (env.AXON_STAGING_MODE === "true" ? "http://localhost:3099" : PRODUCTION_API_BASE)
}

const DEFAULT_BASE_URL = resolveDefaultBaseUrl()

/**
 * How long a request may stall before it is abandoned.
 *
 * `fetch` has NO default timeout in Bun or Node: a connection that stalls
 * mid-flight — a Cloud Run instance dropping the socket during a cold start, an
 * idle NAT mapping expiring, a TLS handshake that never completes — leaves the
 * promise pending forever. The caller does not see an error, a retry, or any
 * output at all; it simply never returns. `axon publish` hung this way for
 * minutes with an empty terminal, intermittently, because whether the socket
 * stalls is a race rather than a property of the request.
 *
 * The 503/429 retry below anticipates cold starts, but it can only act on a
 * RESPONSE. A cold start that stalls the connection instead of answering is
 * invisible to it, which is the gap this closes.
 *
 * Three budgets, because the shapes of request differ by orders of magnitude.
 *
 * A JSON call is a control-plane round trip and has no business taking 30s.
 *
 * An upload carries the source tarball plus README assets — the 5.4MB demo
 * video in a registry README is a real case — and on a slow uplink legitimately
 * runs into minutes, so a budget tight enough to catch a stalled GET would
 * abort honest publishes.
 *
 * PROVISIONING is the third, and it is not a slow round trip — it is a request
 * that builds infrastructure while the caller holds the socket: a Cloud Run
 * revision in production, a spawned agent process against local staging.
 *
 * It had no budget of its own, so it inherited the 30s control-plane one — and
 * local staging's own readiness budget is ALSO 30s (MockDeployments'
 * READY_TIMEOUT_MS). Two identical deadlines racing meant the client aborted at
 * the exact moment the server was still legitimately waiting, and the CLI
 * reported `✗ Provisioning 30.0s` for a deployment that then came up fine.
 *
 * In production the same shape is worse: the service starts, the commitment is
 * billed, and the user is told it failed. A failure they are charged for is the
 * worst possible false negative, which is why this gets a budget with real
 * headroom over both rather than a nudge to the shared one.
 *
 * Deliberately NOT applied to `stream()`: an SSE connection is meant to stay
 * open, so a wall-clock cap there would sever live sessions on purpose.
 */
const REQUEST_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 600_000
export const PROVISION_TIMEOUT_MS = 300_000

/**
 * Combine a caller's signal with a timeout, so either can abort the request.
 *
 * `AbortSignal.any` rather than passing the timeout alone: a caller that
 * supplied its own signal is still entitled to cancel, and dropping theirs to
 * make room for ours would silently break that.
 */
function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(ms)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** `AbortSignal.timeout` rejects with a DOMException named TimeoutError. */
function isTimeout(cause: unknown): boolean {
    return cause instanceof Error && cause.name === "TimeoutError"
}

type HttpOpts = {
    /** Defaults to AXON_API_BASE, then local staging when AXON_STAGING_MODE=true, then production. */
    baseUrl?: string
    /** Resolved live per request — login/logout/refresh are picked up with nothing re-wired. */
    token: () => string | undefined
    /**
     * Called when the backend refuses the credential mid-session (401).
     *
     * A credential can die while the app is running — revoked from the web,
     * expired past refresh, account disabled. Nothing noticed before: the boot
     * check had already passed, so the user sat in an app whose every request
     * failed until they restarted it. One observer here catches it, because
     * `request()` is the single place every authenticated call resolves.
     *
     * Observational only. It cannot alter the response or suppress the
     * HttpError — the caller still sees its own failure — so a subscriber
     * cannot change what any existing code path does. Its throw is swallowed
     * for the same reason.
     *
     * Not called for a 401 the caller EXPECTS (see `expectUnauthorized`),
     * which is how the credential checks themselves avoid re-entering this.
     */
    onUnauthorized?: () => void

    /**
     * A request failed in a way that suggests OUR fault, not the caller's.
     *
     * Same contract as `onUnauthorized`: observational only, cannot alter or
     * suppress the error the caller receives, and its own throw is swallowed
     * so a broken subscriber can never replace a real failure.
     *
     * Fires for 5xx and for transport failures (DNS, TLS, timeout, offline) —
     * the two shapes that mean something is broken. Deliberately NOT for 4xx:
     * a 404 on a name lookup or a 403 on a private artifact is the system
     * working correctly, and reporting those buries real breakage under
     * expected outcomes.
     *
     * The subscriber MUST NOT send through this same Http instance — see
     * Reporting() in platform/reporting.ts, which uses bare fetch precisely
     * so a failing report cannot generate another report.
     */
    onFailure?: (error: unknown, path: string, method: string) => void
}

/**
 * Per-request opt-out of the 401 observer.
 *
 * The auth ladder (me(), refresh()) treats a 401 as its own answer and handles
 * it deliberately — routing those through the global observer would fire a
 * session-died signal for a check that is already reporting the same fact, and
 * `validate()` calling itself is a loop.
 */
export type RequestOptions = {
    expectUnauthorized?: boolean
    /** Per-attempt stall budget. Defaults to REQUEST_TIMEOUT_MS; uploads pass the larger one. */
    timeoutMs?: number
}

/**
 * The single entry point for hitting the backend. Every resource module
 * (registry, cognos, infra, billing, orgs) calls through this instead of
 * raw fetch.
 *
 * Tracing is automatic: every request runs inside its own span — a child of
 * whatever ambient span is active (platform/trace.ts) — and stamps
 * x-axon-trace-id / x-axon-span-id on the wire. Resource modules that want
 * a semantic parent wrap themselves in trace.span("billing.ledger", ...);
 * modules that don't still get per-request spans for free.
 */
export function Http(opts: HttpOpts) {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL

    function resolveHeaders(extra?: RequestInit["headers"]): Headers {
        const headers = new Headers(extra)

        const span = trace.headers()
        if (span) {
            for (const [key, value] of Object.entries(span)) {
                headers.set(key, value)
            }
        }

        const token = opts.token()
        if (token) {
            headers.set("Authorization", `Bearer ${token}`)
        }

        return headers
    }

    /**
     * `timeoutMs: null` opts out entirely — only `stream()`, whose connection
     * is meant to stay open, passes it.
     */
    async function raw(path: string, init?: RequestInit, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<Response> {
        const url = baseUrl + path
        const signal = init?.signal ?? undefined

        // retry on 503 (cold start) and 429 (rate limit) with exponential backoff —
        // attempts share the request span, so a retried request shows as one long span
        const delays = [1000, 2000, 4000]
        for (let attempt = 0; ; attempt++) {
            const headers = resolveHeaders(init?.headers ?? undefined)
            // Re-armed per attempt: the budget is what ONE attempt may stall
            // for. A single signal spanning the retries would leave a request
            // that burned most of its time on a 503 with nothing left to
            // actually succeed in.
            let response: Response
            try {
                response = await fetch(url, {
                    ...init,
                    headers,
                    ...(timeoutMs === null ? {} : { signal: withTimeout(timeoutMs, signal) }),
                })
            } catch (cause) {
                // Say which budget elapsed and on what. A bare TimeoutError
                // names neither, and this failure's whole history is a user
                // staring at a terminal with no idea what was even being
                // attempted. A caller's own abort is theirs and passes through.
                if (isTimeout(cause) && !signal?.aborted && timeoutMs !== null) {
                    throw new Error(
                        `request timed out after ${Math.round(timeoutMs / 1000)}s: ${init?.method ?? "GET"} ${path}`,
                        { cause },
                    )
                }
                throw cause
            }
            if ((response.status === 503 || response.status === 429) && attempt < delays.length) {
                if (signal?.aborted) throw new Error("request aborted")
                await new Promise<void>((resolve, reject) => {
                    const t = setTimeout(resolve, delays[attempt])
                    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("request aborted")) }, { once: true })
                })
                continue
            }
            return response
        }
    }

    async function parseError(response: Response, path: string): Promise<HttpError> {
        let message: string | undefined
        let data: Record<string, unknown> | undefined
        try {
            const text = await response.text()
            if (text) {
                try {
                    const body = JSON.parse(text) as Record<string, unknown>
                    if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
                        data = body.data as Record<string, unknown>
                    }
                    message = (body.message
                        ?? body.statusMessage
                        ?? (typeof body.error === "string" ? body.error : undefined)
                        ?? (typeof data?.error === "string" ? data.error : undefined)) as string | undefined
                } catch {
                    message = text.slice(0, 200)
                }
            }
        } catch {
            // swallowed deliberately — falls through to the generic HttpError below
        }
        return new HttpError(response.status, path, message, data)
    }

    /**
     * Tell the failure observer, never letting it interfere.
     *
     * Wrapped because a subscriber is arbitrary code on the failure path of
     * every request: if it throws, the caller must still receive the real
     * error rather than the subscriber's.
     */
    function notifyFailure(error: unknown, path: string, method: string): void {
        try {
            opts.onFailure?.(error, path, method)
        } catch {
            // A subscriber's fault must never replace the real failure.
        }
    }

    /** One request = one span. The span opens before headers resolve, so its own id goes on the wire. */
    function request<T>(method: string, path: string, init?: RequestInit, options?: RequestOptions): Promise<T> {
        return trace.span(`http ${method} ${path}`, async () => {
            let response: Response
            try {
                response = await raw(path, { ...init, method }, options?.timeoutMs ?? REQUEST_TIMEOUT_MS)
            } catch (cause) {
                // Never reached the backend — DNS, TLS, timeout, offline. No
                // server-side log can possibly hold this, which is what makes
                // it worth reporting. A caller's own abort is not a failure.
                if (!init?.signal?.aborted) notifyFailure(cause, path, method)
                throw cause
            }

            if (!response.ok) {
                // Signal a dead credential to whoever is watching, then fail
                // exactly as before. Deliberately BEFORE the throw and without
                // altering it: this only adds an observation, so no existing
                // caller's error handling changes.
                if (response.status === 401 && !options?.expectUnauthorized) {
                    try {
                        opts.onUnauthorized?.()
                    } catch {
                        // A subscriber's fault must never replace the real
                        // HTTP failure the caller is waiting for.
                    }
                }
                const error = await parseError(response, path)
                // Reporting decides what a reportable status is — see
                // Reporting.httpFailure(). Http's job is to observe, not to
                // classify, so the filter lives in one place rather than here
                // and there.
                notifyFailure(error, path, method)
                throw error
            }
            const text = await response.text()
            return text ? (JSON.parse(text) as T) : (undefined as T)
        })
    }

    return {
        get<T = unknown>(path: string, signal?: AbortSignal) {
            return request<T>("GET", path, { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) })
        },

        /**
         * `timeoutMs` overrides the control-plane budget for the rare request
         * that legitimately runs long — provisioning holds the socket while
         * infrastructure is built. Defaulted, so every ordinary call keeps the
         * tight budget that catches a stalled connection.
         */
        post<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number) {
            return request<T>(
                "POST",
                path,
                {
                    headers: { "Content-Type": "application/json" },
                    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                    ...(signal ? { signal } : {}),
                },
                ...(timeoutMs !== undefined ? [{ timeoutMs }] as const : []),
            )
        },

        /**
         * The auth ladder's own requests — identical to get/post except a 401
         * does NOT fire the session-died observer.
         *
         * A separate pair rather than an option on every verb: exactly two
         * call sites need this (Auth.me() and Auth.refresh(), which treat a
         * 401 as their own answer), and threading a flag through eight
         * signatures would put the decision in front of every caller who will
         * never make it. Named so its purpose is unmissable at the call site.
         */
        auth: {
            get<T = unknown>(path: string, signal?: AbortSignal) {
                return request<T>("GET", path,
                    { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) },
                    { expectUnauthorized: true },
                )
            },
            post<T = unknown>(path: string, body?: unknown, signal?: AbortSignal) {
                return request<T>("POST", path, {
                    headers: { "Content-Type": "application/json" },
                    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                    ...(signal ? { signal } : {}),
                }, { expectUnauthorized: true })
            },
        },

        patch<T = unknown>(path: string, body: unknown, signal?: AbortSignal) {
            return request<T>("PATCH", path, {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                ...(signal ? { signal } : {}),
            })
        },

        put<T = unknown>(path: string, body: unknown, signal?: AbortSignal) {
            return request<T>("PUT", path, {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                ...(signal ? { signal } : {}),
            })
        },

        async delete(path: string, signal?: AbortSignal): Promise<void> {
            await request<void>("DELETE", path, signal ? { signal } : {})
        },

        /**
         * Multipart upload — fetch sets the boundary header itself, so none is
         * set here. Gets the upload budget rather than the control-plane one:
         * this carries the source tarball and README assets, which are megabytes.
         */
        form<T = unknown>(path: string, form: FormData, signal?: AbortSignal) {
            return request<T>("POST", path, { body: form, ...(signal ? { signal } : {}) }, { timeoutMs: UPLOAD_TIMEOUT_MS })
        },

        /**
         * Streaming POST — returns the raw Response for the caller to drain
         * (SSE, NDJSON). Same auth/trace headers and cold-start retry as
         * every other verb; error statuses still throw HttpError. No span
         * wrapper: the request outlives this call by design.
         */
        async stream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
            // No timeout: an SSE connection is SUPPOSED to stay open, so a
            // wall-clock cap here would sever live sessions by design. The
            // caller's own signal remains the way to end one.
            let response: Response
            try {
                response = await raw(path, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
                    body: JSON.stringify(body),
                    ...(signal ? { signal } : {}),
                }, null)
            } catch (cause) {
                if (!signal?.aborted) notifyFailure(cause, path, "STREAM")
                throw cause
            }
            if (!response.ok) {
                const error = await parseError(response, path)
                notifyFailure(error, path, "STREAM")
                throw error
            }
            return response
        },
    }
}

export type HttpClient = ReturnType<typeof Http>

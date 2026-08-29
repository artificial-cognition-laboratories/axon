import type { ErrorReport, ReportFrame, ReportSource } from "@arcforge/types"

type ReportingOpts = {
    /** Where to POST. Resolved from the same base as every other request. */
    baseUrl: string
    /** Release string stamped on every report. Absent in dev, which is honest. */
    release?: string
    /** Coarse runtime descriptor. Never a hostname or a username. */
    platform?: string
    /** Turn ingest off entirely — respected by every path below. */
    enabled?: boolean
}

/**
 * Reporting — the client's outbound crash channel.
 *
 * ── Why it does not use Http() ───────────────────────────────────────────
 *
 * This is the observer that Http() failures feed into. Sending a report
 * THROUGH Http() means a failing report produces a failure that produces a
 * report — an unbounded loop that turns one dead backend into a request
 * storm. So it uses bare fetch, has no retry, and never reports its own
 * failures. A dropped report is the correct outcome here; the alternative
 * is amplifying an outage.
 *
 * ── Fire and forget, deliberately ────────────────────────────────────────
 *
 * send() returns void, not a promise. Reporting must never sit in front of
 * a user-visible operation, and no caller has anything useful to do with
 * the result. The internal promise is caught and discarded — the one place
 * in this codebase where swallowing is right, because the alternative is an
 * unhandled rejection triggered by the network being down.
 */
export function Reporting(opts: ReportingOpts) {
    const enabled = opts.enabled ?? true
    const endpoint = `${opts.baseUrl}/api/reports`

    /**
     * Same failure, same process, sent once.
     *
     * A crash loop can produce thousands of identical failures a minute. The
     * server groups them, but sending each one still spends the user's
     * network and our ingest budget to learn nothing new. This keeps a
     * bounded set of keys already sent and drops repeats.
     *
     * Bounded rather than a plain Set: a long-lived TUI seeing many distinct
     * failures must not grow this forever. When it fills, it clears — a
     * blunt reset that re-sends some failures once, which is far better than
     * a leak in a process that runs for days.
     */
    const seen = new Set<string>()
    const SEEN_LIMIT = 500

    function firstSend(key: string): boolean {
        if (seen.has(key)) return false
        if (seen.size >= SEEN_LIMIT) seen.clear()
        seen.add(key)
        return true
    }

    function send(report: ErrorReport): void {
        if (!enabled) return

        const key = `${report.source}|${report.code ?? "-"}|${report.message}`
        if (!firstSend(key)) return

        const payload: ErrorReport = {
            ...report,
            ...(opts.release !== undefined ? { release: opts.release } : {}),
            ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
            ...(report.context !== undefined ? { context: scrubContext(report.context) } : {}),
        }

        // No await, no retry, no error surface — see the module doc.
        void fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            // A report must never outlive the thing it is reporting on.
            signal: AbortSignal.timeout(5000),
        }).catch(() => {})
    }

    /**
     * Report an HTTP failure from Http()'s observer.
     *
     * Only server-side and transport failures. A 4xx is the system working
     * correctly — a 404 on a name lookup, a 403 on a private artifact, a 400
     * on bad input — and reporting them would bury real breakage under
     * expected outcomes, which is precisely how the last telemetry effort
     * became unreadable.
     *
     * 401 is excluded for a further reason: a dead credential is already
     * surfaced by onUnauthorized, and every request after one dies would
     * report the same fact.
     */
    function httpFailure(error: unknown, path: string, method: string): void {
        const status = statusOf(error)

        if (status !== null) {
            // A 4xx is the system working correctly — a 404 on a name lookup,
            // a 403 on a private artifact, a 400 on bad input. Reporting them
            // buries real breakage under expected outcomes.
            if (status < 500) return
            send({
                source: "cloud",
                message: `${method} ${path} → ${status}${message(error) ? `: ${message(error)}` : ""}`,
                severity: "error",
                context: { path, method, status },
            })
            return
        }

        // No status: a transport failure — DNS, TLS, timeout, offline. These
        // never reached the backend, so no server-side log can possibly hold
        // them, which makes them the most valuable reports we get.
        send({
            source: "cloud",
            message: `${method} ${path} → ${message(error)}`,
            severity: "error",
            ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
            context: { path, method, transport: true },
        })
    }

    return {
        send: send,
        httpFailure: httpFailure,
    }
}

/**
 * Read an HTTP status off a failure, structurally rather than by class.
 *
 * `error instanceof HttpError` was the obvious implementation and it is
 * WRONG here: @arcforge/types resolves to more than one module instance
 * across workspace package boundaries, so the class identity differs
 * between the thrower and this observer and `instanceof` returns false for
 * a genuine HttpError. The symptom was silent and exactly backwards —
 * every 404 fell through to the transport branch and got reported as
 * breakage, which is the noise this filter exists to prevent.
 *
 * Duck-typing the one field that matters cannot break that way. Returns
 * null when there is no status, which IS the transport case.
 */
function statusOf(error: unknown): number | null {
    if (typeof error !== "object" || error === null) return null
    const status = (error as { status?: unknown }).status
    return typeof status === "number" ? status : null
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export type ReportingHandle = ReturnType<typeof Reporting>

/**
 * Keys whose values are safe to forward verbatim.
 *
 * An allowlist, not a denylist. Context is free-form and caller-supplied —
 * anything can end up in it, including prompt text, file contents and
 * tokens — so the safe default must be to drop, and adding a key must be a
 * deliberate act. A denylist protects only against the leaks someone
 * already thought of.
 */
const SAFE_KEYS: ReadonlySet<string> = new Set([
    "path", "method", "status", "transport", "code", "kind", "name",
    "version", "abi", "engine", "model", "provider", "scope", "operation",
    "durationMs", "attempt", "reason", "phase", "agentId", "deploymentId",
])

/**
 * Values that look like credentials, regardless of their key.
 *
 * The allowlist already blocks unknown keys; this catches the case where a
 * SAFE key carries a secret anyway — `name: "axon_live_..."` is a real
 * mistake to make.
 */
const SECRET_SHAPE =
    /(axon_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{16,})/

/**
 * Reduce caller context to something safe to transmit.
 *
 * Three rules, in order:
 *   1. unknown keys are dropped entirely
 *   2. filesystem paths are reduced to a basename — a full path carries the
 *      user's home directory, which is their name on most machines
 *   3. anything shaped like a credential becomes a marker
 *
 * Runs client-side so secrets never leave the machine. The server scrubs
 * again on arrival, because this pass runs in code an attacker controls.
 */
export function scrubContext(context: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(context)) {
        if (!SAFE_KEYS.has(key)) continue
        if (value === null || value === undefined) continue

        if (typeof value === "number" || typeof value === "boolean") {
            out[key] = value
            continue
        }

        if (typeof value !== "string") continue

        if (SECRET_SHAPE.test(value)) {
            out[key] = "[redacted]"
            continue
        }

        out[key] = stripHomePath(value)
    }

    return out
}

/**
 * Reduce a FILESYSTEM path to its basename.
 *
 * `/home/cody/git/arclabs/registry/zero/cognet.config.ts` becomes
 * `cognet.config.ts` — the part identifying the failure survives, the prefix
 * identifying the person does not.
 *
 * Deliberately narrow: only absolute filesystem and Windows drive paths. An
 * earlier version stripped anything containing a slash, which turned the URL
 * path `/api/agents/x` into `x` and destroyed the most useful field on an
 * HTTP failure report. A URL path carries no identity and must survive.
 */
function stripHomePath(value: string): string {
    const isFsPath = /^(\/(home|Users|root|var|tmp|opt)\/|[A-Za-z]:\\)/.test(value)
    if (!isFsPath) return value
    const parts = value.split(/[/\\]/)
    return parts[parts.length - 1] || value
}

/** Flatten err()-style frames onto the wire shape. */
export function toReportFrames(
    frames: Array<{ functionName: string | null; fileName: string | null; lineNumber: number | null }>,
): ReportFrame[] {
    return frames.map(frame => ({
        functionName: frame.functionName,
        // A frame's fileName is ALWAYS a filesystem path, so it is always
        // reduced — unlike context values, where a slash may mean a URL.
        fileName: frame.fileName === null ? null : frame.fileName.split(/[/\\]/).pop() || frame.fileName,
        lineNumber: frame.lineNumber,
    }))
}

export type { ReportSource }

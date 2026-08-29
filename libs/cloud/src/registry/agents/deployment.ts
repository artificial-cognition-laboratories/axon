import { HttpError, type HttpClient } from "../../platform/http"
import { record, str } from "../../platform/parse"
import { DeploymentFailedError, type DeploymentStatus } from "./types"

type DeploymentOpts = {
    id: string
    http: HttpClient
}

/**
 * One running deployment — lifecycle, secrets, observability.
 * Tier/warmth are immutable after provisioning (billing commitment);
 * changing spec means a new deployment.
 */
export function Deployment(opts: DeploymentOpts) {
    const base = `/api/user/deployments/${encodeURIComponent(opts.id)}`

    type LogEntry = { timestamp: string; severity: string; message: string }

    async function status(): Promise<DeploymentStatus> {
        const raw = record(await opts.http.get(`${base}/status`), "status")
        return {
            status: str(raw, "status"),
            ...(typeof raw.url === "string" ? { url: raw.url } : {}),
            ...(typeof raw.lastError === "string" ? { lastError: raw.lastError } : {}),
        }
    }

    async function logs(options?: { limit?: number }): Promise<LogEntry[]> {
        const params = new URLSearchParams()
        if (options?.limit !== undefined) params.set("limit", String(options.limit))
        const raw = record(await opts.http.get(`${base}/logs${params.size ? `?${params}` : ""}`), "logs")
        return Array.isArray(raw.entries)
            ? raw.entries.flatMap(entry => {
                if (!entry || typeof entry !== "object") return []
                const value = entry as Record<string, unknown>
                return typeof value.timestamp === "string" && typeof value.severity === "string" && typeof value.message === "string"
                    ? [{ timestamp: value.timestamp, severity: value.severity, message: value.message }]
                    : []
            })
            : []
    }

    return {
        id: opts.id,
        status: status,

        logs: logs,

        async start(): Promise<void> {
            await opts.http.post(`${base}/start`, {})
        },

        async stop(): Promise<void> {
            await opts.http.post(`${base}/stop`, {})
        },

        /** Rebuild from the latest published version — same machine spec. */
        async redeploy(): Promise<void> {
            await opts.http.post(`${base}/redeploy`, {})
        },

        /** Tear down the deployment (and stop its billing commitment renewing). */
        async delete(): Promise<void> {
            await opts.http.post(`${base}/delete`, {})
        },

        secrets: {
            /** Key names only — values are write-only once set, like GitHub Actions secrets. */
            async list(): Promise<string[]> {
                const raw = record(await opts.http.get(`${base}/secrets`), "secrets")
                return Array.isArray(raw.names) ? raw.names.filter((n): n is string => typeof n === "string") : []
            },

            /** Set/overwrite env secrets — written to Secret Manager, visible to the agent on next boot. */
            async set(secrets: Record<string, string>): Promise<void> {
                await opts.http.put(`${base}/secrets`, { secrets })
            },

            async delete(key: string): Promise<void> {
                await opts.http.delete(`${base}/secrets/${encodeURIComponent(key)}`)
            },
        },

        /**
         * Poll until running. Resolves with the live URL; throws on error
         * state or timeout. Transient poll failures are retried — only a
         * terminal status or the deadline ends the wait.
         *
         * `pollMs` is the gap between status checks (default 2s, unchanged
         * for every real caller). It is an option because the tests assert
         * this loop's DECISIONS — 4xx is terminal, 5xx retries, error status
         * reports its reason — and none of those assertions are about
         * elapsed time. Left hardcoded, seven tests slept a real 2s per
         * iteration to observe logic that resolves instantly at pollMs: 0,
         * which was ~20s of a 60s suite spent waiting on setTimeout.
         *
         * The error-status and timeout branches are not exercised by this
         * package's test suite: provision() is atomic server-side, so a
         * failed provision never returns a deploymentId a client can hold
         * — there is no way to reach a real "error" status or a genuinely
         * still-provisioning deployment through the public AxonCloud()
         * surface without waiting out a real multi-minute deadline.
         * Accepted, understood gap — not an oversight.
         */
        async waitUntilReady(options?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<{ url: string }> {
            const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000
            const pollMs = options?.pollMs ?? 2000
            const deadline = Date.now() + timeoutMs

            /**
             * Read the container's own output for the failure report. A
             * provisioning error names what the control plane saw; the log tail
             * is usually what the user actually needs (a module throwing at boot,
             * a missing env var). Best-effort: if logs are unreachable the error
             * still carries the reason, just without the detail.
             */
            async function logTail(): Promise<LogEntry[]> {
                try {
                    const entries = await logs({ limit: 40 })
                    return entries.slice(-20)
                } catch {
                    return []
                }
            }

            while (Date.now() < deadline) {
                if (options?.signal?.aborted) throw new Error("deployment wait aborted")
                if (pollMs > 0) await new Promise(resolve => setTimeout(resolve, pollMs))

                let current: DeploymentStatus
                try {
                    current = await status()
                } catch (cause) {
                    // A 4xx is not transient: an expired token or a deployment
                    // that no longer exists will never resolve, and swallowing it
                    // meant spinning for five minutes before reporting a
                    // "timeout" that was actually an auth failure.
                    if (cause instanceof HttpError && cause.status >= 400 && cause.status < 500) throw cause
                    continue // 5xx / network — the control plane may still come back
                }

                if (current.status === "running") return { url: current.url ?? "" }
                if (current.status === "error") {
                    throw new DeploymentFailedError({
                        deploymentId: opts.id,
                        phase: "provisioning",
                        reason: current.lastError ?? null,
                        logs: await logTail(),
                    })
                }
            }

            // Timed out while still provisioning/starting. The container may have
            // logged the real cause already, so the tail goes out with it.
            throw new DeploymentFailedError({
                deploymentId: opts.id,
                phase: "timeout",
                reason: `not ready after ${Math.round(timeoutMs / 1000)}s`,
                logs: await logTail(),
            })
        },
    }
}

export type DeploymentHandle = ReturnType<typeof Deployment>

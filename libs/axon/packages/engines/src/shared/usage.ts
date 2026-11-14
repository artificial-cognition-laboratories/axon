import type { AxonEngineDriver, AxonEngineResponse, EngineCloud, ConnectionProvider } from "@arcforge/types"
import { failure } from "./fault"

/** Records one metadata-only fact per hosted request, including errors and cancellation. */
export function UsageDriver(opts: { driver: AxonEngineDriver; cloud: EngineCloud; provider: ConnectionProvider; model: string; source: "account" | "explicit" }) : AxonEngineDriver {
    return {
        get effort() { return opts.driver.effort },
        async *stream(req) {
            const reporter = opts.cloud.user.usage
            const auth = opts.cloud.user.auth
            const identity = auth?.user?.id ?? auth?.token
            if (!reporter || !auth?.token) { yield* opts.driver.stream(req); return }
            const id = crypto.randomUUID()
            const started = Date.now()
            let response: AxonEngineResponse | undefined
            let failed = false
            let upstreamError: unknown
            try {
                for await (const event of opts.driver.stream(req)) {
                    if (event.type === "done") response = event.response
                    else yield event
                }
                if (!response) throw failure({ code: "PROTOCOL", message: "Provider stream ended without a terminal response", retryable: false, provider: opts.provider, model: opts.model })
            } catch (cause) { failed = true; upstreamError = cause; throw cause }
            finally {
                try {
                    if ((opts.cloud.user.auth?.user?.id ?? opts.cloud.user.auth?.token) !== identity) throw new Error("Account changed during the provider request")
                    await reporter.record({ id: id, provider: opts.provider, source: opts.source,
                        model: response?.meta.model ?? opts.model,
                        outcome: req.signal?.aborted || response?.stopReason === "abort" ? "cancelled" : failed ? "failed" : response ? "completed" : "cancelled",
                        durationMs: Date.now() - started,
                        ...(response?.meta.tokens ? { tokens: { in: response.meta.tokens.in, out: response.meta.tokens.out } } : {}) })
                } catch (cause) {
                    // Non-retryable: retrying inference after a reporting outage can spend tokens twice.
                    throw failure({ code: "USAGE_REPORT_FAILED", message: "Provider usage could not be recorded. The model request may have completed; do not retry automatically.", retryable: false, provider: opts.provider, model: opts.model, cause: upstreamError === undefined ? cause : new AggregateError([upstreamError, cause], "Provider and reporting both failed") })
                }
            }
            yield { type: "done", response: response }
        },
    }
}

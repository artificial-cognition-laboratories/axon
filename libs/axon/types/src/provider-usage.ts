import { isConnectionProvider, type ConnectionProvider } from "./connections"

export type ProviderUsageRecord = {
    id: string
    provider: ConnectionProvider
    source: "account" | "explicit"
    model: string
    outcome: "completed" | "failed" | "cancelled"
    durationMs: number
    tokens?: { in: number; out: number }
}
export type ProviderUsageCount = { requests: number; completed: number; failed: number; cancelled: number; inputTokens: number; outputTokens: number; measured: number }
export type ProviderUsageSummary = {
    provider: ConnectionProvider
    days: number
    source: "account" | "explicit" | "all"
    totals: ProviderUsageCount
    daily: Array<ProviderUsageCount & { date: string }>
    models: Array<ProviderUsageCount & { model: string; lastUsedAt: string }>
}

/** Validates the metadata-only reporting contract at external boundaries. */
export function ProviderUsageWire() {
    function object(raw: unknown): Record<string, unknown> {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("PROVIDER_USAGE_INVALID: expected an object")
        return Object.fromEntries(Object.entries(raw))
    }
    function text(raw: unknown, max: number): string {
        if (typeof raw !== "string" || !raw || raw.length > max) throw new Error("PROVIDER_USAGE_INVALID: invalid text")
        return raw
    }
    function number(raw: unknown): number {
        if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new Error("PROVIDER_USAGE_INVALID: invalid count")
        return raw
    }
    function count(raw: unknown): ProviderUsageCount {
        const value = object(raw)
        return { requests: number(value.requests), completed: number(value.completed), failed: number(value.failed), cancelled: number(value.cancelled),
            inputTokens: number(value.inputTokens), outputTokens: number(value.outputTokens), measured: number(value.measured) }
    }
    const values = { object: object, text: text, number: number, count: count }
    function record(raw: unknown): ProviderUsageRecord {
        const value = values.object(raw)
        const id = values.text(value.id, 36)
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("PROVIDER_USAGE_INVALID: invalid identifier")
        if (typeof value.provider !== "string" || !isConnectionProvider(value.provider)) throw new Error("PROVIDER_USAGE_INVALID: unknown provider")
        if (value.source !== "account" && value.source !== "explicit") throw new Error("PROVIDER_USAGE_INVALID: invalid credential source")
        if (value.outcome !== "completed" && value.outcome !== "failed" && value.outcome !== "cancelled") throw new Error("PROVIDER_USAGE_INVALID: invalid outcome")
        const tokens = value.tokens === undefined ? undefined : values.object(value.tokens)
        return { id: id, provider: value.provider, source: value.source, model: values.text(value.model, 200), outcome: value.outcome,
            durationMs: values.number(value.durationMs), ...(tokens ? { tokens: { in: values.number(tokens.in), out: values.number(tokens.out) } } : {}) }
    }
    function summary(raw: unknown): ProviderUsageSummary {
        const value = values.object(raw)
        if (typeof value.provider !== "string" || !isConnectionProvider(value.provider)) throw new Error("PROVIDER_USAGE_INVALID: unknown provider")
        if (value.source !== "account" && value.source !== "explicit" && value.source !== "all") throw new Error("PROVIDER_USAGE_INVALID: invalid source")
        if (!Array.isArray(value.daily) || !Array.isArray(value.models)) throw new Error("PROVIDER_USAGE_INVALID: missing series")
        return { provider: value.provider, source: value.source, days: values.number(value.days), totals: values.count(value.totals),
            daily: value.daily.map(raw => { const item = values.object(raw); return { ...values.count(item), date: values.text(item.date, 10) } }),
            models: value.models.map(raw => { const item = values.object(raw); return { ...values.count(item), model: values.text(item.model, 200), lastUsedAt: values.text(item.lastUsedAt, 40) } }) }
    }
    return { record: record, summary: summary }
}

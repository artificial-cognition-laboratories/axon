import type { HttpClient } from "../../platform/http"
import { num, record, rows, str } from "../../platform/parse"
import type { DailyBalance, SpendByReference, UsageSummary } from "./types"

type UsageOpts = {
    http: HttpClient
}

/** Spend-over-time rollups for the dashboard. */
export function Usage(opts: UsageOpts) {
    return {
        async summary(options?: { days?: number }): Promise<UsageSummary> {
            const params = new URLSearchParams()
            if (options?.days) params.set("days", String(options.days))
            const suffix = params.size > 0 ? `?${params}` : ""

            const raw = await opts.http.get<Record<string, unknown>>(`/api/user/billing/usage${suffix}`)
            const summary = record(raw.summary, "summary")
            return {
                currency: str(summary, "currency"),
                totalMinor: num(summary, "totalMinor"),
                items: rows(summary.items, "items").map(item => ({
                    date: str(item, "date"),
                    amountMinor: num(item, "amountMinor"),
                    kind: str(item, "kind"),
                })),
            }
        },

        /** Day-bucketed spend grouped by referenceType (deployment, token_charge, "other", ...) — the billing page's embedded-selector chart. */
        async spendByReference(options?: { days?: number }): Promise<SpendByReference> {
            const params = new URLSearchParams()
            if (options?.days) params.set("days", String(options.days))
            const suffix = params.size > 0 ? `?${params}` : ""

            const raw = await opts.http.get<Record<string, unknown>>(`/api/user/billing/spend-by-reference${suffix}`)
            return {
                currency: str(raw, "currency"),
                items: rows(raw.items, "items").map(item => ({
                    date: str(item, "date"),
                    referenceType: str(item, "referenceType"),
                    amountMinor: num(item, "amountMinor"),
                })),
            }
        },

        /** Running balance at the end of each day — the balance chart's series. */
        async dailyBalance(options?: { days?: number }): Promise<DailyBalance> {
            const params = new URLSearchParams()
            if (options?.days) params.set("days", String(options.days))
            const suffix = params.size > 0 ? `?${params}` : ""

            const raw = await opts.http.get<Record<string, unknown>>(`/api/user/billing/daily-balance${suffix}`)
            return {
                currency: str(raw, "currency"),
                items: rows(raw.items, "items").map(item => ({
                    date: str(item, "date"),
                    balanceMinor: num(item, "balanceMinor"),
                })),
            }
        },
    }
}

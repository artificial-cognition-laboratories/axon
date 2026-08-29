import type { HttpClient } from "../../platform/http"
import { num, record, rows, str, strOrNull } from "../../platform/parse"
import type { LedgerEntry } from "./types"

type LedgerOpts = {
    http: HttpClient
}

/** The audit trail — every movement of money, newest first. */
export function Ledger(opts: LedgerOpts) {
    return {
        async list(options?: { limit?: number }): Promise<LedgerEntry[]> {
            const params = new URLSearchParams()
            if (options?.limit) params.set("limit", String(options.limit))
            const suffix = params.size > 0 ? `?${params}` : ""

            const raw = await opts.http.get<Record<string, unknown>>(`/api/user/billing/ledger${suffix}`)
            return rows(raw.entries, "entries").map(entry => ({
                id: str(entry, "id"),
                kind: str(entry, "kind"),
                status: str(entry, "status"),
                amountMinor: num(entry, "amountMinor"),
                currency: str(entry, "currency"),
                description: strOrNull(entry, "description"),
                referenceType: strOrNull(entry, "referenceType"),
                referenceId: strOrNull(entry, "referenceId"),
                createdAt: str(entry, "createdAt"),
                metadata: entry.metadata ? record(entry.metadata, "metadata") : {},
            }))
        },
    }
}

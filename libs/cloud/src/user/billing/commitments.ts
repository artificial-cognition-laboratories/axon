import type { HttpClient } from "../../platform/http"
import { bool, num, record, rows, str, strOrNull } from "../../platform/parse"
import type { Commitment, CommitmentQuote } from "./types"

type CommitmentsOpts = {
    http: HttpClient
}

/**
 * Recurring spend — the money view of registry deployments. The deploy
 * action itself lives in the registry domain; this owns quotes, the list,
 * and renewal control. Entries reference back via deploymentId.
 */
export function Commitments(opts: CommitmentsOpts) {
    return {
        /** Quote the monthly price for a machine spec before deploying. */
        async price(input: { tier: string; warmth: string; diskAddOn?: "standard" | "large" | null }): Promise<CommitmentQuote> {
            const raw = await opts.http.post<Record<string, unknown>>("/api/user/billing/commitments/preview", input)
            const quote = record(raw.commitment, "commitment")
            return {
                kind: str(quote, "kind") as CommitmentQuote["kind"],
                amountMinor: num(quote, "amountMinor"),
                currency: str(quote, "currency"),
                periodDays: num(quote, "periodDays"),
                tier: str(quote, "tier"),
                warmth: str(quote, "warmth"),
                diskAddOn: strOrNull(quote, "diskAddOn"),
            }
        },

        async list(): Promise<Commitment[]> {
            const raw = await opts.http.get<Record<string, unknown>>("/api/user/billing/commitments")
            return rows(raw.commitments, "commitments").map(row => ({
                id: str(row, "id"),
                kind: str(row, "kind") as Commitment["kind"],
                status: str(row, "status"),
                deploymentId: strOrNull(row, "deploymentId"),
                amountMinor: num(row, "amountMinor"),
                currency: str(row, "currency"),
                currentPeriodStart: str(row, "currentPeriodStart"),
                currentPeriodEnd: str(row, "currentPeriodEnd"),
                autoRenew: bool(row, "autoRenew"),
                cancelledAt: strOrNull(row, "cancelledAt"),
                metadata: row.metadata ? record(row.metadata, "metadata") : {},
                createdAt: str(row, "createdAt"),
            }))
        },

        /** Stop renewing — runs to the end of the paid period, then the deployment winds down. */
        async cancelRenewal(commitmentId: string): Promise<void> {
            await opts.http.post(`/api/user/billing/commitments/${encodeURIComponent(commitmentId)}/cancel-renewal`, {})
        },

        async resumeRenewal(commitmentId: string): Promise<void> {
            await opts.http.post(`/api/user/billing/commitments/${encodeURIComponent(commitmentId)}/resume-renewal`, {})
        },
    }
}

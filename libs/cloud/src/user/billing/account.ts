import type { HttpClient } from "../../platform/http"
import { bool, record, str, strOrNull, num } from "../../platform/parse"
import type { BillingAccount, BillingBalance } from "./types"

type AccountOpts = {
    http: HttpClient
}

/**
 * The account itself: identity, balance, and the Stripe billing portal.
 * The backend ensures a billing account exists for every authenticated
 * user — a 404 here is a real failure and propagates.
 */
export function Account(opts: AccountOpts) {
    return {
        async get(): Promise<BillingAccount> {
            const raw = await opts.http.get<Record<string, unknown>>("/api/user/billing/account")
            const account = record(raw.account, "account")
            return {
                id: str(account, "id"),
                ownerType: str(account, "ownerType") as BillingAccount["ownerType"],
                ownerId: str(account, "ownerId"),
                status: str(account, "status"),
                currency: str(account, "currency"),
                defaultPaymentMethodId: strOrNull(account, "defaultPaymentMethodId"),
                autoTopupEnabled: bool(account, "autoTopupEnabled"),
            }
        },

        async balance(): Promise<BillingBalance> {
            const raw = await opts.http.get<Record<string, unknown>>("/api/user/billing/balance")
            const balance = record(raw.balance, "balance")
            return {
                currency: str(balance, "currency"),
                postedMinor: num(balance, "postedMinor"),
                reservedMinor: num(balance, "reservedMinor"),
                availableMinor: num(balance, "availableMinor"),
            }
        },

        /** Stripe-hosted billing portal — invoices, tax details, everything we don't rebuild. */
        async portal(options?: { returnUrl?: string }): Promise<{ url: string }> {
            const raw = await opts.http.post<Record<string, unknown>>("/api/user/billing/portal", options ?? {})
            return { url: str(raw, "url") }
        },
    }
}

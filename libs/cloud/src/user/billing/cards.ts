import type { HttpClient } from "../../platform/http"
import { bool, num, record, rows, str } from "../../platform/parse"
import type { Card } from "./types"

type CardsOpts = {
    http: HttpClient
}

/**
 * Stored payment methods. Card numbers never touch this client — add()
 * returns a Stripe setup-intent clientSecret and the caller (web/TUI)
 * completes collection with Stripe's own UI.
 */
export function Cards(opts: CardsOpts) {
    return {
        async list(): Promise<Card[]> {
            const raw = await opts.http.get<Record<string, unknown>>("/api/user/billing/payment-methods")
            return rows(raw.paymentMethods, "paymentMethods").map(card => ({
                id: str(card, "id"),
                brand: str(card, "brand"),
                last4: str(card, "last4"),
                expMonth: num(card, "expMonth"),
                expYear: num(card, "expYear"),
                isDefault: bool(card, "isDefault"),
            }))
        },

        /** Begin adding a card — returns the Stripe setup-intent secret for the caller's Stripe UI. */
        async add(): Promise<{ clientSecret: string }> {
            const raw = await opts.http.post<Record<string, unknown>>("/api/user/billing/setup-intent", {})
            return { clientSecret: str(record(raw, "setup intent"), "clientSecret") }
        },

        /**
         * Call once, right after the caller's Stripe UI confirms the setup
         * intent from add() — reconciles our stored default against
         * Stripe's live state (auto-defaulting a first card). list() is a
         * pure read and never does this on its own.
         */
        async sync(): Promise<void> {
            await opts.http.post("/api/user/billing/payment-methods/sync", {})
        },

        async setDefault(cardId: string): Promise<void> {
            await opts.http.post(`/api/user/billing/payment-methods/${encodeURIComponent(cardId)}/default`, {})
        },

        /** Persist display/attempt order — the dashboard's draggable card list calls this after every reorder. */
        async reorder(orderedIds: string[]): Promise<void> {
            await opts.http.post("/api/user/billing/payment-methods/reorder", { orderedIds })
        },

        async remove(cardId: string): Promise<void> {
            await opts.http.delete(`/api/user/billing/payment-methods/${encodeURIComponent(cardId)}`)
        },
    }
}

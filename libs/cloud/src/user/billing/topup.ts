import type { HttpClient } from "../../platform/http"
import { bool, num, record, str, strOrNull } from "../../platform/parse"
import type { AutoTopupInput, AutoTopupPolicy, TopupResult } from "./types"

type TopupOpts = {
    http: HttpClient
}

function parsePolicy(raw: unknown): AutoTopupPolicy {
    const policy = record(raw, "policy")
    const maxPerDay = policy.maxTopupsPerDay
    return {
        enabled: bool(policy, "enabled"),
        currency: str(policy, "currency"),
        thresholdMinor: num(policy, "thresholdMinor"),
        topupAmountMinor: num(policy, "topupAmountMinor"),
        maxTopupsPerDay: typeof maxPerDay === "number" ? maxPerDay : null,
        lastTriggeredAt: strOrNull(policy, "lastTriggeredAt"),
    }
}

/**
 * Balance top-ups. charge() bills the default stored card immediately;
 * auto is the keep-me-topped-up policy (threshold → amount, rate-limited
 * per day, executed server-side).
 */
export function Topup(opts: TopupOpts) {
    return {
        /**
         * Charge a stored card now — the caller's chosen card if
         * paymentMethodId is given, otherwise the default (falling back
         * through the rest of the stored order on decline). Requires at
         * least one stored card — Cards.add() first.
         */
        async charge(input: { amountMinor: number; paymentMethodId?: string }): Promise<TopupResult> {
            const raw = await opts.http.post<Record<string, unknown>>("/api/user/billing/topups", {
                amountMinor: input.amountMinor,
                ...(input.paymentMethodId ? { paymentMethodId: input.paymentMethodId } : {}),
            })
            const balance = record(raw.balance, "balance")
            return {
                paymentIntentId: str(raw, "paymentIntentId"),
                balance: {
                    currency: str(balance, "currency"),
                    availableMinor: num(balance, "availableMinor"),
                },
            }
        },

        auto: {
            async get(): Promise<AutoTopupPolicy> {
                const raw = await opts.http.get<Record<string, unknown>>("/api/user/billing/topups/auto")
                return parsePolicy(raw.policy)
            },

            async set(input: AutoTopupInput): Promise<AutoTopupPolicy> {
                const raw = await opts.http.put<Record<string, unknown>>("/api/user/billing/topups/auto", input)
                return parsePolicy(raw.policy)
            },
        },
    }
}

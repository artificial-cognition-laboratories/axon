import type { HttpClient } from "../../platform/http"
import { Account } from "./account"
import { Cards } from "./cards"
import { Commitments } from "./commitments"
import { Ledger } from "./ledger"
import { Topup } from "./topup"
import { Usage } from "./usage"

type BillingOpts = {
    http: HttpClient
}

/**
 * Billing — the money view of the account. Pure orchestration:
 *
 *   account()/balance()/portal() — the account itself
 *   cards        — stored payment methods (Stripe setup-intent flow)
 *   topup        — one-off charges + the auto-topup policy
 *   ledger       — audit trail of every movement
 *   commitments  — recurring spend (registry deployments, by deploymentId)
 *   usage        — spend-over-time rollup
 *
 * The deploy action lives in the registry domain; billing only quotes it
 * (commitments.price) and shows/controls the money side.
 */
export function Billing(opts: BillingOpts) {
    const account = Account({ http: opts.http })

    return {
        account: account.get,
        balance: account.balance,
        portal: account.portal,

        cards: Cards({ http: opts.http }),
        topup: Topup({ http: opts.http }),
        ledger: Ledger({ http: opts.http }),
        commitments: Commitments({ http: opts.http }),
        usage: Usage({ http: opts.http }),
    }
}

export type BillingHandle = ReturnType<typeof Billing>

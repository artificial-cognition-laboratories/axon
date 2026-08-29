/**
 * Billing domain types + strict parsers.
 *
 * Money is always minor units (`amountMinor`) plus an ISO currency code —
 * never floats; formatting is a UI concern.
 *
 * Parsers pin the backend contract: one shape, camelCase, required fields
 * throw on drift. No `?? fallback` chains, no snake_case tolerance — if the
 * backend changes shape, we want the loud failure here, not fake zeros in
 * the user's balance.
 */

export type BillingAccount = {
    id: string
    ownerType: "user" | "org"
    ownerId: string
    status: string
    currency: string
    defaultPaymentMethodId: string | null
    autoTopupEnabled: boolean
}

export type BillingBalance = {
    currency: string
    postedMinor: number
    reservedMinor: number
    availableMinor: number
}

export type Card = {
    id: string
    brand: string
    last4: string
    expMonth: number
    expYear: number
    isDefault: boolean
}

export type LedgerEntry = {
    id: string
    kind: string
    status: string
    amountMinor: number
    currency: string
    description: string | null
    referenceType: string | null
    referenceId: string | null
    createdAt: string
    metadata: Record<string, unknown>
}

export type AutoTopupPolicy = {
    enabled: boolean
    currency: string
    thresholdMinor: number
    topupAmountMinor: number
    maxTopupsPerDay: number | null
    lastTriggeredAt: string | null
}

/** Caller-settable subset of the policy. */
export type AutoTopupInput = {
    enabled?: boolean
    thresholdMinor?: number
    topupAmountMinor?: number
    maxTopupsPerDay?: number | null
}

export type TopupResult = {
    paymentIntentId: string
    balance: {
        currency: string
        availableMinor: number
    }
}

/** Recurring spend — the money view of a registry deployment (kinds grow later). */
export type Commitment = {
    id: string
    kind: "deployment"
    status: string
    deploymentId: string | null
    amountMinor: number
    currency: string
    currentPeriodStart: string
    currentPeriodEnd: string
    autoRenew: boolean
    cancelledAt: string | null
    metadata: Record<string, unknown>
    createdAt: string
}

export type CommitmentQuote = {
    kind: "deployment"
    amountMinor: number
    currency: string
    periodDays: number
    tier: string
    warmth: string
    diskAddOn: string | null
}

export type UsageSummary = {
    currency: string
    totalMinor: number
    items: Array<{
        date: string
        amountMinor: number
        kind: string
    }>
}

export type SpendByReference = {
    currency: string
    items: Array<{
        date: string
        referenceType: string
        amountMinor: number
    }>
}

export type DailyBalance = {
    currency: string
    items: Array<{
        date: string
        balanceMinor: number
    }>
}

import type { HttpClient } from "../platform/http"
import { num, str } from "../platform/parse"
import { Reports } from "./reports"
import { Stats } from "./stats"

type StaffOpts = {
    http: HttpClient
}

/**
 * Staff — operator-only actions. The client half of the staff-gated backend
 * endpoints; the real authorization is enforced server-side on the caller's
 * verified identity (isStaff), never here. A non-staff caller reaching these
 * gets a 403 from the backend.
 */
export function Staff(opts: StaffOpts) {
    return {
        /** The operator dashboard's charts and lists. */
        stats: Stats({ http: opts.http }),

        /** Grouped crash reports — what is broken right now. */
        reports: Reports({ http: opts.http }),

        /**
         * Grant comp credit to a user by handle — no charge, staff only.
         * amountMinor is minor units (e.g. 5000 = £50.00).
         */
        async credit(input: { handle: string; amountMinor: number; reason?: string }): Promise<{
            userId: string
            entryId: string
            balanceMinor: number
        }> {
            const raw = await opts.http.post<Record<string, unknown>>("/api/admin/credit", {
                handle: input.handle,
                amountMinor: input.amountMinor,
                ...(input.reason ? { reason: input.reason } : {}),
            })
            return {
                userId: str(raw, "userId"),
                entryId: str(raw, "entryId"),
                balanceMinor: num(raw, "balanceMinor"),
            }
        },
    }
}

export type StaffT = ReturnType<typeof Staff>

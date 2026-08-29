/**
 * identity — who you are on this machine.
 *
 *     Account:  cody@hexlabs.co.uk
 *     Scope:    @cody
 *     Member:   since March 2025
 *
 * Shared by `login` (which shows it once the flow settles) and `whoami` (which
 * shows nothing else). One block, because they answer the same question and a
 * second rendering of it would be somewhere for the two to disagree.
 *
 * ── Scope is the load-bearing field ────────────────────────────────────────
 *
 * A username OWNS your registry namespace, and nothing can be published until
 * one is set. `whoami` used to print it unlabelled beneath the email, where it
 * read as a display name — so the fact that gates publishing looked like
 * decoration, and its ABSENCE looked like nothing at all. Rendered as `@cody`
 * it is recognisably the scope; rendered as "not set" it says what is wrong
 * while the user is looking, rather than at a failed publish later.
 */

import { next, rows, type Row } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type Identity = {
    email: string
    /** The registry scope — the username, without the `@`. Absent when unset. */
    scope?: string
    /** Account creation time, as a millisecond timestamp. */
    memberSince?: number
}

export type IdentityOpts = {
    /**
     * Point at the fix when no scope is set.
     *
     * Off for `login`, which has already said it in its own flow; on for
     * `whoami`, where this block is the entire answer.
     */
    hintMissingScope?: boolean
}

export function identity(r: RendererHandle, who: Identity, opts: IdentityOpts = {}): string[] {
    const facts: Row[] = [
        { label: "Account", value: who.email, arrow: false },
        { label: "Scope", value: who.scope ? `@${who.scope}` : "not set", arrow: false },
    ]
    if (who.memberSince !== undefined) {
        facts.push({ label: "Member", value: `since ${monthYear(who.memberSince)}`, arrow: false })
    }

    const lines = rows(r, facts)

    if (!who.scope && opts.hintMissingScope) {
        lines.push("")
        lines.push(next(r, "set a username at axon.arclabs.it/settings to publish"))
    }

    return lines
}

/** A timestamp as "March 2025" — the precision a join date is ever read at. */
export function monthYear(ms: number): string {
    return new Date(ms).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
}

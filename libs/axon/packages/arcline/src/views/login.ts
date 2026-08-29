/**
 * login — the device flow, from code to identity.
 *
 *     Sign in to Axon
 *
 *     ➜  https://axon.arclabs.it/device
 *
 *        Code   BXFT-QZLM
 *
 *     ⠹ waiting for approval  0:42 left
 *
 * ── The user leaves the terminal, which changes what the screen is for ─────
 *
 * Every other view in this package narrates work happening here. This one
 * narrates work happening somewhere else — in a browser, by hand. So its job
 * is not progress reporting, it is: make the code impossible to mistype, and
 * make it obvious the terminal is still alive and still waiting.
 *
 * Hence the two things the previous version left on the floor, both already
 * present in `DeviceAuthorization` and both ignored:
 *
 *   `verificationUriComplete` embeds the code in the URL. A user who can click
 *   a link never types a code at all, which removes the entire failure mode
 *   this screen is otherwise designed around. It is shown as the primary
 *   route, with the code kept visible for anyone pasting into another device.
 *
 *   `expiresIn` bounds the wait. A code silently dies after a few minutes; a
 *   spinner with no clock cannot distinguish "still waiting" from "expired
 *   four minutes ago", so the countdown is the honest thing to show and the
 *   only way the user knows to hurry.
 *
 * ── No "replacing the existing session" notice ─────────────────────────────
 *
 * `axon login` always runs, including when a credential already exists — that
 * is the recovery path for an expired or revoked one, so refusing it is the
 * trap. But announcing WHOSE session is being replaced tells the user nothing
 * they can act on: overwhelmingly they are re-authenticating as themselves,
 * and the line reads as a warning about something that is not a problem. The
 * identity block at the end says who they ended up as, which is the fact that
 * actually matters.
 *
 * ── The code is spaced, not styled ─────────────────────────────────────────
 *
 * `BXFT-QZLM` is read off a screen and typed into a phone. It gets the widest
 * visual berth of anything in the package for one reason: every character has
 * to survive that trip.
 */

import { header, next, status } from "../components/index.ts"
import { identity } from "./identity.ts"
import { hyperlink } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"
import { errorReport } from "../components/index.ts"

export type LoginOpts = {
    /**
     * The pending authorization. Absent before the backend has issued one —
     * that moment is a spinner, not a blank screen.
     */
    authorization?: {
        /** Where to go. Prefer `verificationUriComplete` when the terminal links. */
        verificationUri: string
        /** The same URL with the code embedded — one click, nothing to type. */
        verificationUriComplete?: string
        /** The code itself, for anyone entering it by hand. */
        userCode: string
        /** Seconds left before the code expires. Counts down while waiting. */
        secondsLeft?: number
    }
    frame?: string
    /** The signed-in identity, once approved. */
    result?: {
        email: string
        /**
         * The registry scope — the user's username, without the `@`.
         *
         * Absent when they have not set one, which is not cosmetic: a username
         * OWNS the namespace and nothing can be published without it. The CLI
         * currently discovers this at a failed publish, in three separate
         * places; surfacing it here means the first command that could have
         * told them is the one that does.
         */
        scope?: string
        /** Account creation time, as a millisecond timestamp. */
        memberSince?: number
    }
    failure?: {
        error: AxonErrorLike
        hint?: string
    }
}

export function login(r: RendererHandle, opts: LoginOpts): string {
    const lines: string[] = []

    lines.push("")
    lines.push(header(r, { title: "Sign in to Axon" }))

    // The code and its URL are shown only while they are still usable. Once
    // the flow has settled either way they are dead — and a dead code left on
    // screen invites someone to keep entering it and be told no.
    if (opts.authorization && !opts.result && !opts.failure) {
        const auth = opts.authorization
        const target = auth.verificationUriComplete ?? auth.verificationUri

        // The URL is shown COMPLETE — code included — not just linked to.
        //
        // Displaying the bare `/auth/device` while the code rode invisibly in
        // the href meant a click worked and a copy-paste did not: the text
        // looked like an ordinary URL, so anyone who selected it rather than
        // clicking landed on a form and had to type the code by hand anyway.
        // The point of `verificationUriComplete` is that nobody types the
        // code, and that only holds if the string you can see is the string
        // that carries it.
        lines.push("")
        lines.push(next(r, r.links ? hyperlink(target, target) : target))
        lines.push("")
        // Spaced wide and painted primary — this is the one string the user has
        // to transcribe, and it competes with nothing else on screen.
        lines.push(`   ${r.c.dim("Code")}   ${r.c.bold(r.c.primary(auth.userCode))}`)
    }

    if (!opts.result && !opts.failure) {
        lines.push("")
        lines.push(status(
            r,
            "pending",
            opts.authorization ? "waiting for approval" : "requesting a code",
            opts.authorization?.secondsLeft !== undefined
                ? `${countdown(opts.authorization.secondsLeft)} left`
                : undefined,
            opts.frame,
        ))
    }

    if (opts.result) {
        // The identity block, shaped like publish's and deploy's: the outcome,
        // then the facts it produced. The email is IN the block rather than in
        // the ✓ line so the three facts read as one group — the ✓ says what
        // happened, the block says what you now have.
        lines.push("")
        lines.push(status(r, "ok", "signed in"))
        lines.push("")

        // Shared with `whoami` — see views/identity.ts. The missing-scope
        // hint is on, because a first login is exactly when someone learns
        // they cannot publish yet.
        lines.push(...identity(r, opts.result, { hintMissingScope: true }))
    }

    if (opts.failure) {
        lines.push("")
        lines.push(...errorReport(r, opts.failure.error, {
            ...(opts.failure.hint ? { hint: opts.failure.hint } : {}),
        }))
    }

    lines.push("")
    return lines.join("\n")
}

/** Seconds as m:ss — the format a countdown is read in. */
export function countdown(seconds: number): string {
    const safe = Math.max(0, Math.floor(seconds))
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`
}

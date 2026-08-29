import type { EscalationCall } from "@arcforge/types"
import type { StoreT } from "../../services/store"

/**
 * A surface that can answer an escalation — the TUI, the CLI, Fleet.
 *
 * Registered rather than injected because WHICH surface is listening changes
 * at runtime: the TUI attaches when it boots and detaches on exit, while a
 * headless `axon run` never registers one at all. A handler that had to be
 * supplied at construction would make "nobody is listening" unrepresentable,
 * and that is the case this design exists to handle honestly.
 */
export type EscalationHandler = (request: {
    /** The store request id — what an answer names, and what a later approval finds. */
    id: string
    agent: string
    sessionId: string
    fn: string
    subject: string
}) => Promise<boolean>

type EscalationsOpts = {
    store: StoreT
}

export type EscalationsT = ReturnType<typeof Escalations>

/**
 * Escalations — the platform's answer to "may I?".
 *
 * A sibling of Requests() rather than a method on it: that owns subagent
 * spawning, this owns policy decisions, and one object holding both would be
 * two concerns sharing a name.
 *
 * ── Three outcomes, and only one of them asks a human ────────────────────────
 *
 *   1. A GRANT covers it     → allow, silently, no prompt and no wait.
 *   2. A SURFACE is attached  → prompt, and wait for the answer.
 *   3. NOTHING is attached    → deny immediately.
 *
 * (3) is the one worth stating. The capsule's own fallback is a 30-second
 * timeout, which turns every escalation in a headless run — CI, a cron, a
 * deployment — into a 30-second stall before the same denial. Failing fast is
 * both quicker and more honest: the request is recorded, the call gets a
 * denial naming it, and approving it later writes a grant the NEXT attempt
 * reads. "Answer later" cannot mean "the call waits" — the wake is blocked
 * inside a tool call, and parking that for hours would freeze the agent
 * mid-turn holding a capsule and a run.
 *
 * ── Every request is recorded, answered or not ──────────────────────────────
 *
 * Including the ones a human answers instantly. The log is what makes the
 * decision auditable and what a later approval attaches to; a prompt that
 * resolved without leaving a trace is a capability granted with no record of
 * who granted it.
 */
export function Escalations(opts: EscalationsOpts) {
    let handler: EscalationHandler | null = null

    return {
        /**
         * Attach the surface that answers. Returns a detach function.
         *
         * Last registration wins rather than stacking: two surfaces prompting
         * for one decision would race, and the loser's prompt would linger
         * over a question already answered.
         */
        handle(next: EscalationHandler): () => void {
            handler = next
            return () => {
                if (handler === next) handler = null
            }
        },

        /** Whether any surface is currently listening. */
        get attached(): boolean {
            return handler !== null
        },

        /**
         * Decide one escalation, for the capsule that raised it.
         *
         * `agent` and `sessionId` come from the kernel that owns the capsule —
         * this has no way to know them, and a request that could not name its
         * agent could not be granted to one.
         */
        async decide(context: { agent: string; sessionId: string }, call: EscalationCall): Promise<boolean> {
            const profile = opts.store.profiles.active()
            const subject = subjectOf(call)

            // No profile — a headless run outside one. Nothing to consult and
            // nowhere to record, so the capsule's own default stands.
            if (!profile) return false

            const granted = profile.grants.covers(context.agent, call.fn, subject)
            if (granted) {
                const request = profile.requests.raise({
                    agent: context.agent,
                    sessionId: context.sessionId,
                    fn: call.fn,
                    subject,
                })
                profile.requests.settle(request.id, {
                    decision: "allow",
                    by: "grant",
                    at: Date.now(),
                    grantId: granted.id,
                })
                return true
            }

            const request = profile.requests.raise({
                agent: context.agent,
                sessionId: context.sessionId,
                fn: call.fn,
                subject,
            })

            if (!handler) {
                // Recorded as expired rather than denied: nothing refused
                // this, nobody was there. Approving it later writes a grant
                // the next attempt reads.
                profile.requests.settle(request.id, { decision: "deny", by: "expired", at: Date.now() })
                return false
            }

            try {
                const allowed = await handler({
                    id: request.id,
                    agent: context.agent,
                    sessionId: context.sessionId,
                    fn: call.fn,
                    subject,
                })
                profile.requests.settle(request.id, { decision: allowed ? "allow" : "deny", by: "user", at: Date.now() })
                return allowed
            } catch {
                // A surface that threw did not decide. Denied — the capsule's
                // posture everywhere — and recorded as expired rather than as
                // a user's choice, because no user made one.
                profile.requests.settle(request.id, { decision: "deny", by: "expired", at: Date.now() })
                return false
            }
        },
    }
}

/**
 * What the rule was matched against.
 *
 * The mediator evaluates the FIRST string argument — a command, a host, a
 * path — so that is what a grant has to cover. Falling back to the fn name
 * keeps a zero-argument call grantable rather than producing a grant whose
 * subject is empty and matches everything.
 */
function subjectOf(call: EscalationCall): string {
    const first = call.args[0]
    return typeof first === "string" && first.length > 0 ? first : call.fn
}

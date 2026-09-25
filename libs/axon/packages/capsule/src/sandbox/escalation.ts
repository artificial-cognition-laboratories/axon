import type { CapsuleCommand, EscalationCall } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"

const DECIDE_TIMEOUT_MS = 30_000

type EscalationOpts = {
    send(cmd: CapsuleCommand): void
    bus: CapsuleBusT
    /** The one decision-maker. Absent = deny everything. */
    decide?: (call: EscalationCall) => Promise<boolean>
}

/**
 * Escalation — answers the mediator's "may I?" asks. The inverse protocol
 * direction: event in → command out.
 *
 * One callback, one timeout, default deny. A throwing or hanging decider
 * denies — the sandbox must never be left waiting on a policy answer.
 * Every verdict is recorded as capsule:policy:decision.
 */
export function Escalation(opts: EscalationOpts) {
    const { send, bus, decide } = opts

    bus.on("process:policy:escalation", e => {
        const started = Date.now()

        function answer(allow: boolean, reason?: "headless") {
            send({ id: e.id, type: "policy:response", allow, ...(reason ? { reason } : {}) })
            bus.emit("process:policy:decision", { id: e.id, allow, durationMs: Date.now() - started })
        }

        // Nobody to ask. Refused immediately rather than left to the timeout —
        // and labelled, because "nobody was there" and "someone said no" are
        // different facts to whoever is reading the log of a blocked agent.
        if (!decide) {
            answer(false, "headless")
            return
        }

        const call: EscalationCall = { id: e.id, fn: e.fn, args: e.args, rule: e.rule }

        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            answer(false)
        }, DECIDE_TIMEOUT_MS)

        decide(call).then(
            allow => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                answer(allow)
            },
            () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                answer(false)
            },
        )
    })
}

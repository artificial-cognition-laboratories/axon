import type { CapsuleCommand, EscalationCall } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"

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
 * One callback, no deadline. Human decisions wait until answered.
 * An absent or throwing decider denies.
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

        // Nobody to ask. Refused immediately rather than left waiting —
        // and labelled, because "nobody was there" and "someone said no" are
        // different facts to whoever is reading the log of a blocked agent.
        if (!decide) {
            answer(false, "headless")
            return
        }

        const call: EscalationCall = { id: e.id, fn: e.fn, args: e.args, rule: e.rule }

        decide(call).then(
            allow => answer(allow),
            () => answer(false),
        )
    })
}

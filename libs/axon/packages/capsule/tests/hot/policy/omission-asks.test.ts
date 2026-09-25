import { Capsule } from "@arcforge/capsule"
import type { EscalationCall } from "@arcforge/types"

/**
 * Omission asks — asserted through the capsule, not just the decider.
 *
 * ── What this is about ──────────────────────────────────────────────────────
 *
 * The first minutes of using Axon. A new user creates an agent, installs a
 * module, and the agent's first command is a program nobody has written a rule
 * about — because they have not written a policy at all. That used to end at
 * `shell.run:axon denied · no rule permits it`, which is a sentence with no
 * next step in it unless you go and read the docs.
 *
 * The rule is now uniform: an explicit allow allows, an explicit deny denies,
 * and silence asks. These tests exercise it through a real `Capsule()`, because
 * the unit tests over `decideShell` passed the whole time the behaviour was
 * broken — the verdict was computed correctly and then discarded one layer up
 * by a `check()` that re-resolved a TOOLS rule for a program address, found
 * none, and denied by omission.
 *
 * That is the gap these exist to close: the decision and its DELIVERY are
 * different things, and only an end-to-end assertion covers both.
 */
describe("an undeclared program asks rather than refusing", () => {
    it("asks the decider, and runs when the answer is yes", async () => {
        const asked: string[] = []
        const capsule = Capsule({
            // A user at a TUI. No policy at all — the state every agent is in
            // before anyone writes one.
            escalate: async (call: EscalationCall) => {
                asked.push(call.fn)
                return true
            },
        } as never)
        await capsule.boot()

        const result = await capsule.exec(`await process.run("echo hello")`)

        // It was ASKED about, by name — the prompt can say which program.
        expect(asked).toContain("shell.run:echo")
        // …and having been allowed, it actually ran.
        expect(result.denials ?? []).toHaveLength(0)

        await capsule.shutdown()
    })

    it("refuses when the answer is no, and says a person said so", async () => {
        const capsule = Capsule({ escalate: async () => false } as never)
        await capsule.boot()

        const result = await capsule.exec(`await process.run("echo hello")`)

        expect(result.denials).toHaveLength(1)
        // A decision somebody made — distinct from nobody being there.
        expect(result.denials[0]!.rule).toBe("escalation-denied")

        await capsule.shutdown()
    })

    /**
     * The invariant the old `fallback: "deny"` parameter existed to protect,
     * now enforced by the absence of a decider instead of by a flag.
     *
     * A bare `Capsule()` runs foreign, model-emitted code with nobody watching.
     * It must still run nothing.
     */
    it("with nobody to ask, refuses immediately and says so", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const started = Date.now()
        const result = await capsule.exec(`await process.run("echo hello")`)
        const elapsed = Date.now() - started

        expect(result.denials).toHaveLength(1)
        expect(result.denials[0]!.rule).toBe("escalation-headless")

        // Immediately, not after the 30s escalation timeout. A CI run that
        // stalled half a minute per command would be a worse failure than the
        // refusal it is reporting.
        expect(elapsed).toBeLessThan(5_000)

        await capsule.shutdown()
    })

    it("an explicit grant is not re-asked", async () => {
        let asks = 0
        const capsule = Capsule({
            policy: { shell: { allow: ["echo"] } },
            escalate: async () => {
                asks += 1
                return true
            },
        } as never)
        await capsule.boot()

        await capsule.exec(`await process.run("echo hello")`)

        // The whole point of writing a policy: a rule that names the program is
        // a decision already made, and asking again would make the file
        // pointless.
        expect(asks).toBe(0)

        await capsule.shutdown()
    })

    it("an explicit deny is not softened into a question", async () => {
        let asks = 0
        const capsule = Capsule({
            policy: { shell: { deny: ["echo"] } },
            escalate: async () => {
                asks += 1
                return true
            },
        } as never)
        await capsule.boot()

        const result = await capsule.exec(`await process.run("echo hello")`)

        expect(asks).toBe(0)
        expect(result.denials).toHaveLength(1)
        expect(result.denials[0]!.rule).toBe("denied")

        await capsule.shutdown()
    })

    /**
     * The shape from the report: `allow` names one program, and a DIFFERENT one
     * is run. The allowlist has said nothing about the second, so it asks.
     */
    it("a program outside a declared allowlist asks rather than refusing", async () => {
        const asked: string[] = []
        const capsule = Capsule({
            policy: { shell: { allow: ["git"] } },
            escalate: async (call: EscalationCall) => {
                asked.push(call.fn)
                return false
            },
        } as never)
        await capsule.boot()

        await capsule.exec(`await process.run("echo hello")`)

        expect(asked).toContain("shell.run:echo")

        await capsule.shutdown()
    })
})

import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon, driver } from "../../../setup/axon"

/**
 * A reply that parses to no block at all.
 *
 * The failure this covers was silent and total: a model answered in bare prose
 * — no `<text>` wrapper — the AIR parser discarded every character of it
 * (text outside a block has nowhere to go), and the run completed clean. No
 * output, no retry, no error. The user saw a blank screen and a healthy
 * session, which is the worst possible combination: nothing to read, and
 * nothing to look up.
 *
 * Two behaviours are asserted here, and they are the whole fix. The model is
 * told what it did wrong and gets to correct it — which is enough almost every
 * time, because the reply was already right, just unwrapped. And when it never
 * corrects, the failure is loud.
 */

function response(text: string): AxonEngineRawEvent {
    return {
        type: "done",
        response: {
            text,
            stopReason: "end",
            meta: { provider: "unwrapped", model: "unwrapped", durationMs: 1 },
        },
    }
}

/** Emits `text` as a real stream, the way a driver does. */
function* emit(text: string): Generator<AxonEngineRawEvent> {
    yield { type: "text:delta", content: text }
    yield response(text)
}

describe("kernel failure: a reply with no block", () => {
    it("tells the model what it did wrong, and takes the corrected reply", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "unwrapped",
            create: () => ({
                async *stream() {
                    calls++
                    // Attempt 1 is what luna actually sent: a complete, correct
                    // answer with no wrapper anywhere.
                    if (calls === 1) {
                        yield* emit("Yep, I'm here. What can I help you with? <done/>")
                        return
                    }
                    yield* emit("<text>Yep, I'm here.</text><done/>")
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        await expect(runtime.kernel.request({ content: "are you there?" })).resolves.toBeDefined()

        // Retried rather than accepted-empty. Before the fix this was 1: the
        // retry budget was gated on a declared `output` contract, and an
        // ordinary chat turn declares none.
        expect(calls).toBe(2)

        // The diagnostic is committed as an entry, which is what puts it in the
        // NEXT attempt's rendered context — the model reads its own error and
        // rewrites against it. A fault that only reached the kernel log would
        // steer nothing.
        const faults = runtime.session.entries.filter(
            e => e.type === "axon:system:message" && e.data.type === "format-violation",
        )
        expect(faults).toHaveLength(1)
        expect(faults[0]?.data.attributes?.code).toBe("OUTPUT_EMPTY")
        expect(faults[0]?.data.content).toContain("<text>")
        // The reply the model must wrap is visible to it — as its own
        // rejected output committed beside the correction, not quoted inside
        // it. Quoting it in both places put the same text on screen twice.
        const rejected = runtime.session.entries.filter(e => e.type === "axon:system:malformed")
        expect(rejected).toHaveLength(1)
        expect((rejected[0] as { data: { content: string } }).data.content).toContain("Yep, I'm here.")
        expect(faults[0]?.data.content).not.toContain("Yep, I'm here.")

        // And the corrected reply is delivered normally.
        const output = runtime.session.entries.filter(e => e.type === "cognet:output:text")
        expect(output.length).toBeGreaterThan(0)

        await runtime.shutdown()
    })

    /**
     * A bare `<done/>` is a complete reply, not an empty one.
     *
     * It is what a model sends when the previous turn already spoke and acted
     * and there is nothing left to add — and it is the exact signal the loop's
     * stop condition reads. Rejecting it forced a model with nothing to say to
     * invent something three times, then failed the wake outright.
     */
    it("accepts a bare <done/> as a finished turn rather than an empty one", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "done-only",
            create: () => ({
                async *stream() {
                    calls++
                    yield* emit("<done/>")
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        await expect(runtime.kernel.request({ content: "thanks" })).resolves.toBeDefined()

        // Once. Not retried, and not failed.
        expect(calls).toBe(1)

        await runtime.shutdown()
    })

    /**
     * The failure that killed an 82-second run: the model wrapped complete,
     * correct TypeScript in `<lemma_code><code>` — a tag pair that does not
     * exist. The old diagnostic said "wrap your content", which reads as a
     * contradiction to a model that plainly did, and gave it no gradient to
     * follow.
     */
    it("names the invented tag rather than restating the rules", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "mistagged",
            create: () => ({
                async *stream() {
                    calls++
                    if (calls === 1) {
                        yield* emit("<lemma_code><code>const x = 1</code></lemma_code>")
                        return
                    }
                    yield* emit("<text>fixed</text><done/>")
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await expect(runtime.kernel.request({ content: "go" })).resolves.toBeDefined()

        // The diagnostic is committed as an entry, which is what carries it
        // into the next attempt's context. It must name the tag the model
        // actually used and the block it should have used instead.
        const faults = runtime.session.entries.filter(
            e => e.type === "axon:system:message" && e.data.type === "format-violation",
        )
        expect(faults.length).toBe(1)
        const message = String((faults[0] as { data: { content: string } }).data.content)
        expect(message).toContain("lemma_code")
        expect(message).toContain("<script>")

        await runtime.shutdown()
    })

    /**
     * The correction must reach the MODEL, not just the log.
     *
     * Violations are committed as entries, and entries render once per tick —
     * but every retry happens inside one tick. A session-only diagnostic is
     * therefore written somewhere the model cannot read until the turn it was
     * meant to fix has already failed. A real run showed three byte-identical
     * prompts across three attempts.
     */
    it("puts the correction in the next attempt's request", async () => {
        const prompts: string[] = []
        let calls = 0
        const def: AxonEngineDef = {
            name: "steered",
            create: () => ({
                async *stream(req: { messages: readonly { content: string }[] }) {
                    calls++
                    prompts.push(req.messages.map(m => m.content).join("\n"))
                    if (calls === 1) {
                        yield* emit("<lemma_code>const x = 1</lemma_code>")
                        return
                    }
                    yield* emit("<text>fixed</text><done/>")
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await expect(runtime.kernel.request({ content: "go" })).resolves.toBeDefined()

        expect(calls).toBe(2)
        // The second prompt is the first plus a correction naming the fault.
        expect(prompts[1]!.length).toBeGreaterThan(prompts[0]!.length)
        expect(prompts[1]).toContain("lemma_code")

        await runtime.shutdown()
    })

    it("fails loudly when the model never wraps its reply", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "unwrapped",
            create: () => ({
                async *stream() {
                    calls++
                    yield* emit("still no tags here")
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        // Throws rather than resolving with nothing. A caller that gets a
        // silent empty success cannot tell it from a model with nothing to say.
        await expect(runtime.kernel.request({ content: "hello" })).rejects.toMatchObject({
            code: "AX-OUTPUT-003",
        })

        // Bounded: the default budget, not an unbounded hammer on a model that
        // is never going to comply.
        expect(calls).toBe(3)

        // Every attempt left the model a diagnostic, so the record shows what
        // it was told and that it did not act on it.
        const faults = runtime.session.entries.filter(
            e => e.type === "axon:system:message" && e.data.type === "format-violation",
        )
        expect(faults).toHaveLength(3)

        await runtime.shutdown()
    })

    it("does not treat a reply that spoke but forgot <done/> as empty", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "unwrapped",
            create: () => ({
                async *stream() {
                    calls++
                    // Spoke, but never yields — so the cognet loop keeps
                    // ticking. That is the loop's own stop condition doing its
                    // job, and it is emphatically NOT this failure: the reply
                    // produced real output, and retrying it inside one wake
                    // would duplicate what the user already saw.
                    yield* emit("<text>I said something</text>")
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        // The harness stops a runaway loop after 8 ticks; that is expected here
        // and is not what is under test.
        await runtime.kernel.request({ content: "hello" }).catch(() => {})

        // The point: no attempt was ever classified as empty, so nothing was
        // retried for THIS reason and the model was never told it produced no
        // block. Every call is a fresh tick, not a retry within one.
        const faults = runtime.session.entries.filter(
            e => e.type === "axon:system:message" && e.data.type === "format-violation",
        )
        expect(faults).toHaveLength(0)

        // And each tick spoke — the output reached the record rather than
        // being discarded as unusable.
        expect(runtime.session.entries.filter(e => e.type === "cognet:output:text").length).toBeGreaterThan(0)

        await runtime.shutdown()
    })
})

import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon, driver } from "../../../setup/axon"

/**
 * More blocks than the grammar allows.
 *
 * Several scripts in one message run as a CONCURRENT batch, which the model
 * does not expect — a real run wrote a file in one block and read it in the
 * next, and the read lost the race. Another emitted five, then closed with
 * `</script><done/>` followed by a further `<text>`, having lost track of
 * its own message boundary.
 */
describe("kernel failure: too many blocks", () => {
    function response(text: string): AxonEngineRawEvent {
        return { type: "done", response: { text, stopReason: "end", meta: { provider: "many", model: "many", durationMs: 1 } } }
    }
    function* emit(text: string): Generator<AxonEngineRawEvent> {
        yield { type: "text:delta", content: text }
        yield response(text)
    }

    it("rejects two scripts, and takes the corrected single-step reply", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "many",
            model: "many",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    if (calls === 1) {
                        yield* emit(`<script>1 + 1</script><script>2 + 2</script><done/>`)
                        return
                    }
                    if (calls === 2) {
                        yield* emit(`<script>1 + 1</script><done/>`)
                        return
                    }
                    // The tick after the script's stdout returns: nothing left to do.
                    yield* emit(`<text>done</text><done/>`)
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await expect(runtime.kernel.request({ content: "go" })).resolves.toBeDefined()

        // Attempt 1 rejected, attempt 2 accepted, then a tick to close the turn.
        expect(calls).toBe(3)

        // The diagnostic names the real hazard, not just the rule.
        const faults = runtime.session.entries.filter(
            e => e.type === "axon:system:message" && e.data.type === "format-violation",
        )
        const message = String((faults[0] as { data: { content: string } }).data.content)
        expect(message).toContain("Too many blocks")
        expect(message).toContain("at the same time")

        // The rejected reply itself is in the log, verbatim — a correction the
        // model cannot see the subject of is a scolding, not a diagnostic.
        const rejected = runtime.session.entries.filter(e => e.type === "axon:system:malformed")
        expect(rejected).toHaveLength(1)
        const raw = (rejected[0] as { data: { content: string; code: string; attempt: number } }).data
        expect(raw.content).toContain("<script>1 + 1</script>")
        expect(raw.content).toContain("<script>2 + 2</script>")
        expect(raw.code).toBe("OUTPUT_TOO_MANY_BLOCKS")
        expect(raw.attempt).toBe(1)

        await runtime.shutdown()
    }, 30_000)

    it("accepts one template and one script together", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "ok",
            model: "ok",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    if (calls === 1) {
                        yield* emit(`<text>doing it</text><script>1 + 1</script><done/>`)
                        return
                    }
                    yield* emit(`<text>done</text><done/>`)
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await expect(runtime.kernel.request({ content: "go" })).resolves.toBeDefined()
        // Two ticks, no retry: the reply was accepted, its script ran, and the
        // tick after the stdout closed the turn.
        expect(calls).toBe(2)

        const faults = runtime.session.entries.filter(
            e => e.type === "axon:system:message" && e.data.type === "format-violation",
        )
        expect(faults).toHaveLength(0)

        await runtime.shutdown()
    }, 30_000)
})

/**
 * Where the correction reaches the model.
 *
 * A retry that appends the diagnostic after the rendered document puts a
 * `<system>` block outside `</timeline>` — outside every structure the context
 * just established, in the last position on the wire. Models were observed
 * emitting bare prose immediately after being corrected for bare prose, which
 * is the behaviour that context demonstrates.
 */
describe("kernel failure: the correction is re-rendered, not appended", () => {
    function* emit(text: string): Generator<AxonEngineRawEvent> {
        yield { type: "text:delta", content: text }
        yield { type: "done", response: { text, stopReason: "end", meta: { provider: "r", model: "r", durationMs: 1 } } }
    }

    it("puts the rejected reply and its correction inside the timeline", async () => {
        const seen: string[] = []
        let calls = 0
        const def: AxonEngineDef = {
            name: "r",
            model: "r",
            create: () => ({
                async *stream(req: { messages: readonly { content: string }[] }): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    seen.push(req.messages.map(m => m.content).join("\n"))
                    if (calls === 1) {
                        yield* emit(`<script>1 + 1</script><script>2 + 2</script><done/>`)
                        return
                    }
                    yield* emit(`<text>ok</text><done/>`)
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await runtime.kernel.request({ content: "go" })

        expect(calls).toBeGreaterThanOrEqual(2)

        // The retry sees its own rejected output and the verdict on it.
        expect(seen[1]).toContain(`status="rejected"`)
        expect(seen[1]).toContain("Too many blocks")

        // And both are INSIDE the document. Nothing follows the closing tag —
        // that position is what taught the model blocks may float free.
        const tail = seen[1]!.slice(seen[1]!.lastIndexOf("</timeline>"))
        expect(tail).not.toContain("format-violation")
        expect(tail).not.toContain("Too many blocks")

        await runtime.shutdown()
    }, 30_000)
})

/**
 * A surplus block AFTER text has already reached the user.
 *
 * Retrying means asking the model to answer again and discarding the first
 * attempt. That is only honest while the caller has been shown NOTHING —
 * otherwise the discarded text sits on screen with its replacement underneath.
 *
 * `<text>...</text><text>second</text>` is the one shape where the two rules
 * collide. The first block closes, `texts` is 1, no retry path can fire, so it
 * streams — correct at that instant. The second block then makes `texts` 2,
 * which IS a retry path, and by then the first block has crossed.
 *
 * The runtime used to throw `AXON_INTERNAL: retry reached after N block(s)
 * already streamed to the caller`, killing the wake in front of the user. It
 * was not a broken invariant; it was the one case the invariant could not have
 * both ways.
 *
 * Resolved in favour of what the user already has: keep the reply, drop the
 * surplus, correct the model through the normal fault channel. Nothing on
 * screen is ever discarded, and the model still learns the rule.
 */
describe("kernel failure: a surplus block after streaming", () => {
    function response(text: string): AxonEngineRawEvent {
        return { type: "done", response: { text, stopReason: "end", meta: { provider: "late", model: "late", durationMs: 1 } } }
    }
    /** Many small deltas — what a real provider does, and what the old assertion counted. */
    function* streamed(text: string): Generator<AxonEngineRawEvent> {
        for (const chunk of text.match(/.{1,8}/gs) ?? []) yield { type: "text:delta", content: chunk }
        yield response(text)
    }

    function engine(first: string): { def: AxonEngineDef; calls: () => number } {
        let calls = 0
        return {
            calls: () => calls,
            def: {
                name: "late",
                model: "late",
                create: () => ({
                    async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                        calls++
                        if (calls === 1) { yield* streamed(first); return }
                        yield* streamed(`<text>done</text><done/>`)
                    },
                }),
            },
        }
    }

    it("does not kill the wake when a second text block follows a streamed one", async () => {
        // THE reported failure: the wake died mid-answer with AX-UNKNOWN-001.
        const { def } = engine(`<text>first answer</text><text>second</text><done/>`)
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        await expect(runtime.kernel.request({ content: "go" })).resolves.toBeDefined()

        await runtime.shutdown()
    }, 30_000)

    it("keeps the text the user already read", async () => {
        const { def } = engine(`<text>first answer</text><text>second</text><done/>`)
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await runtime.kernel.request({ content: "go" })

        const said = runtime.session.entries
            .filter(e => e.type === "cognet:output:text")
            .map(e => String((e as { data: { content?: string } }).data.content ?? ""))
            .join("")

        expect(said).toContain("first answer")

        await runtime.shutdown()
    }, 30_000)

    it("drops the surplus block rather than delivering it", async () => {
        // The whole point of refusing it. Delivering both would be the
        // grammar violation the check exists to catch.
        //
        // Asserted on the EXACT text, not on "does not contain second": the
        // surplus streams in chunks, so a leak shows up as a fragment like
        // `"se"` that a substring check for the whole word sails straight
        // past. That is precisely how the leak survived the first version of
        // this test.
        const { def } = engine(`<text>first answer</text><text>second</text><done/>`)
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await runtime.kernel.request({ content: "go" })

        const said = runtime.session.entries
            .filter(e => e.type === "cognet:output:text")
            .map(e => String((e as { data: { content?: string } }).data.content ?? ""))
            .join("")

        expect(said).toBe("first answer")

        await runtime.shutdown()
    }, 30_000)

    it("tells the model what it did wrong", async () => {
        // Dropping the block silently would teach it nothing, and it would
        // keep making the same mistake for the rest of the session.
        const { def } = engine(`<text>first answer</text><text>second</text><done/>`)
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await runtime.kernel.request({ content: "go" })

        const faults = runtime.session.entries.filter(
            e => e.type === "axon:system:message" && (e as { data: { type: string } }).data.type === "format-violation",
        )
        expect(faults.length).toBeGreaterThan(0)
        expect(String((faults[0] as { data: { content: string } }).data.content)).toContain("Too many blocks")

        await runtime.shutdown()
    }, 30_000)

    it("keeps the dropped block in the durable record", async () => {
        // Content the model meant to send must not vanish without a trace —
        // a graceful degradation that leaves no evidence is an invisible one.
        const { def } = engine(`<text>first answer</text><text>second</text><done/>`)
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await runtime.kernel.request({ content: "go" })

        const rejected = runtime.session.entries.filter(e => e.type === "axon:system:malformed")
        expect(rejected).toHaveLength(1)
        expect(String((rejected[0] as { data: { content: string } }).data.content)).toContain("second")

        await runtime.shutdown()
    }, 30_000)

    it("does NOT re-ask the model — the user has already read the answer", async () => {
        // The difference from every other violation path. Retrying here would
        // put a second answer under the one on screen.
        const { def, calls } = engine(`<text>first answer</text><text>second</text><done/>`)
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await runtime.kernel.request({ content: "go" })

        // One call for the reply, one for the tick that closes the turn — and
        // crucially no THIRD call re-answering the same question.
        expect(calls()).toBeLessThanOrEqual(2)

        await runtime.shutdown()
    }, 30_000)

    it("still retries when nothing has reached the user", async () => {
        // The switch is `streamedOut > 0`, not "a violation happened". Two
        // scripts stream nothing, so retrying is still strictly better there:
        // the user sees one clean answer instead of a partial one plus a
        // correction.
        const { def, calls } = engine(`<script>1 + 1</script><script>2 + 2</script><done/>`)
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await runtime.kernel.request({ content: "go" })

        // A retry really happened — more calls than the accept path takes.
        expect(calls()).toBeGreaterThan(1)

        await runtime.shutdown()
    }, 30_000)
})

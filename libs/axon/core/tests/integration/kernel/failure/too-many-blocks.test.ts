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

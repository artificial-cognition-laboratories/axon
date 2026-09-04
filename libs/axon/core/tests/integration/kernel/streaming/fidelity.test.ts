import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon, driver } from "../../../setup/axon"

/**
 * STREAMED TEXT MUST REASSEMBLE BYTE FOR BYTE.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 *
 * A delta whose content was only whitespace was DISCARDED — the guard read
 * `if (pending?.trim())` and the next line overwrote `pending`, so those
 * characters were gone. A provider that split a stream as
 * `"…projectRoot:string"`, `"\n"`, `"  cron:string"` committed
 * `projectRoot:string  cron:string`.
 *
 * Observed in a real session: the engine's own recorded `text` was perfectly
 * formed while the streamed assembly had lost newlines and single spaces. It
 * read as the model producing malformed markdown, which it had not.
 *
 * Markdown is whitespace-significant, so the damage is not cosmetic and it
 * COMPOUNDS: a lost newline merges a list item into the prose above it,
 * collapses a fence's indentation, and every later line inherits the drift.
 *
 * ── Why the assertion is equality, not a heuristic ──────────────────────────
 *
 * "No token is dropped" is the invariant. Anything weaker — a length check, a
 * substring match, a trimmed comparison — passes the exact bug that produced
 * this file, because what was lost was whitespace and that is what those
 * checks discard first.
 */
describe("kernel streaming: text fidelity", () => {
    function engine(deltas: string[]): AxonEngineDef {
        const text = deltas.join("")
        return {
            name: "chunks",
            model: "chunks",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    for (const content of deltas) yield { type: "text:delta", content }
                    yield {
                        type: "done",
                        response: { text, stopReason: "end", meta: { provider: "chunks", model: "chunks", durationMs: 1 } },
                    }
                },
            }),
        }
    }

    /** What the session actually recorded, reassembled the way a reader does. */
    async function streamed(deltas: string[]): Promise<string> {
        const runtime = await Axon({ blueprint: { config: { providers: [driver(engine(deltas))] } } })
        try {
            await runtime.kernel.request({ content: "go" })
            return runtime.session.entries
                .filter(entry => entry.type === "cognet:output:text")
                .map(entry => String((entry.data as { content?: string }).content ?? ""))
                .join("")
        } finally {
            await runtime.shutdown()
        }
    }

    it("keeps a newline that arrived on its own", async () => {
        // THE reported split, verbatim.
        const deltas = ["<text>projectRoot:", "s", "tring", "\n", "  cron:", "s", "tring</text><done/>"]

        expect(await streamed(deltas)).toBe("projectRoot:string\n  cron:string")
    }, 30_000)

    it("keeps a single space that arrived on its own", async () => {
        // The other half of the observed damage: `type AgentSchedule ={`.
        const deltas = ["<text>type AgentSchedule", " ", "= {</text><done/>"]

        expect(await streamed(deltas)).toBe("type AgentSchedule = {")
    }, 30_000)

    it("keeps consecutive whitespace deltas", async () => {
        // A blank line between paragraphs is two newlines, and a provider may
        // split them. Losing either one merges the paragraphs.
        const deltas = ["<text>first", "\n", "\n", "second</text><done/>"]

        expect(await streamed(deltas)).toBe("first\n\nsecond")
    }, 30_000)

    it("keeps indentation inside a fenced block", async () => {
        // The case that made a long reply progressively unreadable — every
        // line after a lost newline inherits the drift.
        const body = [
            "```ts",
            "type A = {",
            "  id: string",
            "  nested: {",
            "    deep: string",
            "  }",
            "}",
            "```",
        ].join("\n")
        // Split at EVERY character: the worst case a provider can produce.
        const deltas = ["<text>", ...body.split(""), "</text><done/>"]

        expect(await streamed(deltas)).toBe(body)
    }, 30_000)

    it("keeps a whitespace tail rather than losing the block's close", async () => {
        // A reply ending on a newline is most of them. The tail was dropped
        // AND the group never received `final: true`, leaving it open in the
        // consumer's fold forever.
        const deltas = ["<text>done thinking", "\n\n", "</text><done/>"]

        expect(await streamed(deltas)).toBe("done thinking\n\n")
    }, 30_000)

    it("does not paint a bubble for a block that said nothing", async () => {
        // What the original guard was RIGHT about: a block whose whole content
        // is whitespace paints a bullet with nothing beside it.
        //
        // It never reaches the timeline, but not because the chunk is thrown
        // away — a reply that produced no visible output is refused upstream
        // as OUTPUT_EMPTY and retried, which is a stronger answer than
        // silently rendering nothing. Asserted through the failure rather than
        // through an empty string, so this keeps testing the same fact if the
        // retry budget ever changes.
        const deltas = ["<text>", "\n", "</text><done/>"]

        const failure = await streamed(deltas).catch((error: Error & { code?: string }) => error)

        expect(failure).toBeInstanceOf(Error)
        expect((failure as { code?: string }).code).toBe("AX-OUTPUT-003")
    }, 30_000)

    it("reassembles to exactly what the engine recorded", async () => {
        // The invariant in general form: whatever the provider sent, the
        // streamed assembly and the final text agree. A split anywhere must
        // not change the answer.
        const body = "# Heading\n\n- one\n- two\n\n```json\n{\n  \"a\": 1\n}\n```\n\nTrailing.\n"
        const deltas = ["<text>", ...body.match(/.{1,3}/gs)!, "</text><done/>"]

        expect(await streamed(deltas)).toBe(body)
    }, 30_000)
})

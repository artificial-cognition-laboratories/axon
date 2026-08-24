import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon, driver } from "../../../setup/axon"

/**
 * A text block with nothing visible in it.
 *
 * Forwarded as a message before, so a `<text>` the model opened and closed
 * over a newline reached the UI as an empty bullet — a bubble with nothing
 * beside it. The guard was on truthiness, and `"\n"` is truthy.
 */
describe("kernel: an empty text block", () => {
    function engine(replies: string[]): AxonEngineDef {
        let n = 0
        return {
            name: "e", model: "e",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    const text = replies[Math.min(n++, replies.length - 1)]!
                    yield { type: "text:delta", content: text }
                    yield { type: "done", response: { text, stopReason: "end", meta: { provider: "e", model: "e", durationMs: 1 } } }
                },
            }),
        }
    }

    it("emits no message for whitespace-only text beside a script", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [driver(engine([`<text>\n  </text><script>1+1</script><done/>`, `<text>done</text><done/>`]))] } },
        })
        await runtime.kernel.request({ content: "go" })

        const said = runtime.session.entries.filter(e => e.type === "cognet:output:text")
        // Only the real reply from the closing tick — never a blank one.
        expect(said.every(e => String((e.data as { content: string }).content).trim().length > 0)).toBe(true)

        await runtime.shutdown()
    }, 30_000)

    it("treats a reply that is ONLY an empty text block as no reply at all", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "e", model: "e",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    const text = ++calls === 1 ? `<text>   </text><done/>` : `<text>real answer</text><done/>`
                    yield { type: "text:delta", content: text }
                    yield { type: "done", response: { text, stopReason: "end", meta: { provider: "e", model: "e", durationMs: 1 } } }
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await runtime.kernel.request({ content: "go" })

        // It retried rather than completing a turn the user saw nothing from.
        expect(calls).toBeGreaterThan(1)
        const said = runtime.session.entries.filter(e => e.type === "cognet:output:text")
        expect(said.some(e => String((e.data as { content: string }).content).includes("real answer"))).toBe(true)

        await runtime.shutdown()
    }, 30_000)
})

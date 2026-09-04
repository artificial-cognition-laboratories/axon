import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon, driver } from "../../../setup/axon"

/**
 * A block whose closing tag never arrived.
 *
 * Reported as OUTPUT_EMPTY before — "your reply contained no block" — while
 * the correction quoted that very block back as proof. A model told a script
 * block is not a script block has nothing to correct, and a real run looped
 * until it exhausted its retries.
 */
describe("kernel failure: a truncated block", () => {
    it("says the block never closed, not that the reply was empty", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "cut",
            model: "cut",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    // The provider stops mid-block: no </script> ever arrives.
                    const text = calls === 1
                        ? `<script>const result = await fs.query({ glob: "**/x.ts" }); result`
                        : `<text>done</text><done/>`
                    yield { type: "text:delta", content: text }
                    yield { type: "done", response: { text, stopReason: "end", meta: { provider: "cut", model: "cut", durationMs: 1 } } }
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await expect(runtime.kernel.request({ content: "go" })).resolves.toBeDefined()

        const faults = runtime.session.entries.filter(
            e => e.type === "axon:system:message" && e.data.type === "format-violation",
        )
        const message = String((faults[0] as { data: { content: string } }).data.content)

        expect(message).toContain("never closed")
        expect(message).toContain("</script>")
        // The contradiction this replaced: telling a model that sent a script
        // that it sent no script.
        expect(message).not.toContain("No block in your reply")

        await runtime.shutdown()
    }, 30_000)

    /**
     * The same fault, in a block that already streamed.
     *
     * The script case above never sets `spoke` — a truncated script emits
     * nothing to the UI — so the truncation guard was reached. TEXT streams as
     * it arrives, so `spoke` is true long before the missing `</text>` is
     * known, and the guard (`!spoke && !acted && truncated`) was skipped
     * entirely. A malformed reply carrying `<done/>` was therefore ACCEPTED,
     * and the `<done/>` ended the turn: observed in production as a long answer
     * that stopped mid-sentence, with the tag swallowed into the prose.
     */
    it("rejects a truncated text block even though it already streamed", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "cut-text",
            model: "cut-text",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    // No </text> ever arrives — and <done/> lands inside it.
                    const text = calls === 1
                        ? `<text from="agent" lang="md">\n## Scope result\n\nA long answer that stops mid-\n<done/>`
                        : `<text>recovered</text><done/>`
                    yield { type: "text:delta", content: text }
                    yield { type: "done", response: { text, stopReason: "end", meta: { provider: "cut-text", model: "cut-text", durationMs: 1 } } }
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })
        await expect(runtime.kernel.request({ content: "go" })).resolves.toBeDefined()

        const faults = runtime.session.entries.filter(
            e => e.type === "axon:system:message" && e.data.type === "format-violation",
        )

        // The reply must be refused and re-requested, not accepted as speech.
        expect(faults.length).toBeGreaterThan(0)
        expect(String((faults[0] as { data: { content: string } }).data.content)).toContain("never closed")
        expect(calls).toBeGreaterThan(1)

        await runtime.shutdown()
    }, 30_000)
})

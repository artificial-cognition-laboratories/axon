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
})

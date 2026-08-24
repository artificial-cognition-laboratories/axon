import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon, driver } from "../../../setup/axon"

/** An engine that emits one script block, then finishes. */
function scripted(code: string): AxonEngineDef {
    let calls = 0
    return {
        name: "scripted",
        create: () => ({
            async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                // The script on the first turn, then stop — the harness cognet
                // loops until <done/> arrives with nothing to act on.
                calls++
                const text = calls === 1 ? `<script>${code}</script>` : "<done/>"
                yield { type: "text:delta", content: text }
                yield {
                    type: "done",
                    response: { text, stopReason: "end", meta: { provider: "scripted", model: "scripted", durationMs: 1 } },
                }
            },
        }),
    }
}

/**
 * A tool result large enough to swamp the context.
 *
 * One call once returned 244k characters — ~61k tokens — quadrupling the
 * context in a single tick and stalling the run that read it. Tools are
 * expected to bound themselves; this is the backstop for the ones that do not.
 */
describe("kernel: oversized action results", () => {
    const previous = process.env.AXON_MAX_RESULT_CHARS
    beforeAll(() => { process.env.AXON_MAX_RESULT_CHARS = "2000" })
    afterAll(() => {
        if (previous === undefined) delete process.env.AXON_MAX_RESULT_CHARS
        else process.env.AXON_MAX_RESULT_CHARS = previous
    })

    it("truncates a huge result and says so in the result itself", async () => {
        const runtime = await Axon({
            cwd: "/tmp",
            blueprint: { config: { providers: [driver(scripted('console.log("x".repeat(50_000))'))] } },
        })
        await runtime.kernel.request({ content: "go" })

        const results = runtime.session.entries.filter(e => e.type === "cognet:action:result")
        expect(results.length).toBe(1)

        const content = String((results[0] as { data: { content: string } }).data.content)

        // Bounded, and honest about it — a silently trimmed result teaches the
        // model its query was fine, so it never narrows.
        expect(content.length).toBeLessThan(3_000)
        expect(content).toContain("characters truncated")
        expect(content).toContain("narrow the query")

        await runtime.shutdown()
    }, 30_000)

    it("leaves an ordinary result untouched", async () => {
        const runtime = await Axon({
            cwd: "/tmp",
            blueprint: { config: { providers: [driver(scripted('console.log("small output")'))] } },
        })
        await runtime.kernel.request({ content: "go" })

        const results = runtime.session.entries.filter(e => e.type === "cognet:action:result")
        const content = String((results[0] as { data: { content: string } }).data.content)
        expect(content).toContain("small output")
        expect(content).not.toContain("truncated")

        await runtime.shutdown()
    }, 30_000)
})

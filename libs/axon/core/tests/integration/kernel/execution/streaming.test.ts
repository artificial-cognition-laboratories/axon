import { Axon } from "../../../setup/axon"
import type { AxonEngineRawEvent } from "@arcforge/types"

/**
 * Streaming liveness — a reply must reach the user AS the model writes it.
 *
 * ── The regression this exists to prevent ───────────────────────────────────
 *
 * `Engine.stream()` accumulated every parsed block in an array and yielded the
 * whole array after the attempt finished. The buffer was there so a shape
 * violation could discard an attempt and retry having shown the user nothing —
 * a real requirement, but implemented far more broadly than it needed to be.
 *
 * The effect was that a reply the model wrote over twenty seconds appeared all
 * at once when it completed, at an apparent token rate far above what the
 * provider could produce. Nothing was lost and nothing errored, so no existing
 * test noticed: the transcript was byte-for-byte correct, it just arrived in
 * one burst.
 *
 * That is why these tests assert on TIMING rather than on content. Correctness
 * of the assembled text is covered elsewhere; what is uniquely checkable here
 * is that the chunks were spread out in time, which is the entire user-visible
 * property.
 */

/** Streams `chunks` text deltas `gapMs` apart inside one <text> block. */
function pacedDriver(chunks: number, gapMs: number) {
    return {
        name: "paced",
        create: () => ({
            async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                const parts = [
                    "<text>",
                    ...Array.from({ length: chunks }, (_, i) => `part${i} `),
                    "</text><done/>",
                ]
                let full = ""
                for (const part of parts) {
                    await new Promise(resolve => setTimeout(resolve, gapMs))
                    full += part
                    yield { type: "text:delta", content: part }
                }
                yield {
                    type: "done",
                    response: { text: full, stopReason: "end", meta: { provider: "paced", model: "paced", durationMs: 0 } },
                }
            },
        }),
    }
}

async function collectArrivals(chunks: number, gapMs: number) {
    const runtime = await Axon({
        blueprint: { config: { providers: [{ provider: "paced", driver: pacedDriver(chunks, gapMs) } as never] } },
    })

    const started = Date.now()
    const arrivals: number[] = []
    runtime.bus.onAny((type: string) => {
        if (type === "cognet:output:text") arrivals.push(Date.now() - started)
    })

    await runtime.kernel.request({ content: "go" })

    const text = runtime.session.entries
        .filter(entry => entry.type === "cognet:output:text")
        .map(entry => (entry.data as { content: string }).content)
        .join("")

    await runtime.shutdown()
    return { arrivals, text }
}

describe("kernel streaming: output reaches the user as it is written", () => {
    it("spreads reply chunks over the time the engine took to produce them", async () => {
        const CHUNKS = 10
        const GAP_MS = 40
        const { arrivals } = await collectArrivals(CHUNKS, GAP_MS)

        expect(arrivals.length).toBeGreaterThan(1)

        const spread = arrivals[arrivals.length - 1]! - arrivals[0]!

        // The engine wrote over ~CHUNKS * GAP_MS. Asserting on HALF of that is
        // deliberate: the exact figure depends on scheduler timing and on the
        // parser's one-step hold, and a tight bound would flake on a loaded
        // machine. The buffered failure mode produces a spread of ~0-1ms, so
        // anything in this range distinguishes the two unambiguously.
        expect(spread, `chunks arrived within ${spread}ms of each other — output is being buffered until the reply completes`)
            .toBeGreaterThan((CHUNKS * GAP_MS) / 2)
    }, 30000)

    it("streams without duplicating the text it already sent", async () => {
        // The other half of the fix. Events that have already crossed must not
        // be re-yielded in the terminal flush, or the reply renders once as it
        // streams and a second time, whole, underneath it.
        const { text } = await collectArrivals(6, 20)
        expect(text).toBe("part0 part1 part2 part3 part4 part5 ")
    }, 30000)

    it("still delivers a complete reply when the engine streams instantly", async () => {
        // The degenerate case: everything arrives in one delta. Nothing to
        // spread out, but the reply must still be whole and un-duplicated.
        const { text } = await collectArrivals(3, 0)
        expect(text).toBe("part0 part1 part2 ")
    }, 30000)
})

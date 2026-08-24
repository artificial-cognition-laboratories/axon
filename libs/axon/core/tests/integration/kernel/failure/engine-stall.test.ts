import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon, driver } from "../../../setup/axon"

/**
 * A stream that goes quiet mid-call.
 *
 * A real run hung indefinitely this way: `kernel:providers: [firstToken` landed,
 * the upstream then sent nothing, and because the only abort path was the
 * caller's own signal, nothing on this side was watching. The agent sat on
 * "Working…" until the process was killed — no error, no retry, no timeout.
 *
 * The guard measures silence BETWEEN events rather than total call time, so a
 * model thinking hard is left alone and a dead connection is not.
 */
describe("kernel failure: a stalled engine stream", () => {
    // A 90s window is correct in production and useless in a test; the guard
    // reads this per call so the behaviour can be exercised in milliseconds.
    const previous = process.env.AXON_STREAM_IDLE_MS
    beforeAll(() => { process.env.AXON_STREAM_IDLE_MS = "250" })
    afterAll(() => {
        if (previous === undefined) delete process.env.AXON_STREAM_IDLE_MS
        else process.env.AXON_STREAM_IDLE_MS = previous
    })

    function response(text: string): AxonEngineRawEvent {
        return {
            type: "done",
            response: { text, stopReason: "end", meta: { provider: "stall", model: "stall", durationMs: 1 } },
        }
    }

    it("abandons a stream that stops producing, and retries", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "stall",
            create: () => ({
                async *stream() {
                    calls++
                    if (calls === 1) {
                        // A token, then silence — exactly the observed shape.
                        yield { type: "text:delta", content: "<text>thinking" } as AxonEngineRawEvent
                        await new Promise(() => {}) // never resolves
                        return
                    }
                    yield { type: "text:delta", content: "<text>done</text>" } as AxonEngineRawEvent
                    yield response("<text>done</text><done/>")
                },
            }),
        }

        const runtime = await Axon({
            blueprint: { config: { providers: [driver(def)] } },
        })

        await expect(runtime.kernel.request({ content: "go" })).resolves.toBeDefined()

        // The stalled attempt was abandoned and a second one made — without the
        // guard this test never returns at all.
        expect(calls).toBe(2)

        await runtime.shutdown()
    }, 30_000)
})

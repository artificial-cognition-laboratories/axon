import { Axon, driver } from "../../../setup/axon"
import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"

/** An engine whose stream() only resolves once `release()` is called — full control over timing. */
function slowEngine() {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })

    const def: AxonEngineDef = {
        name: "slow",
        create: () => ({
            async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                await gate
                // Real AIR-tagged text. Two things matter: <done/> signals
                // the loop's stop condition (the parser only sees literal
                // grammar tags, not response.text), and the content must sit
                // inside a REAL block tag. This said <text> for a long time,
                // which is not one — so every reply here parsed to nothing and
                // these tests passed on a response the parser was discarding.
                const text = "<text>done</text><done/>"
                yield { type: "text:delta", content: text }
                yield {
                    type: "done",
                    response: {
                        text,
                        stopReason: "end",
                        meta: { provider: "slow", model: "slow", tokens: { in: 0, out: 0, total: 0 }, durationMs: 0 },
                    },
                }
            },
        }),
    }

    return { def, release: () => release!() }
}

describe("kernel concurrency: single run", () => {
    it("a second stream() while one is in-flight throws RUN_IN_PROGRESS", async () => {
        const { def, release } = slowEngine()
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        const first = runtime.kernel.request({ content: "one" }) // in-flight, gated on release()

        expect(() => runtime.kernel.stream({ content: "two" })).toThrow(expect.objectContaining({ code: "AX-KERNEL-002" }))

        release()
        await first
        await runtime.shutdown()
    })

    it("the lock releases once the run completes — a fresh run is accepted afterward", async () => {
        const { def, release } = slowEngine()
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        const first = runtime.kernel.request({ content: "one" })
        release()
        await first

        await expect(runtime.kernel.request({ content: "two" })).resolves.toBeDefined()

        await runtime.shutdown()
    })

    it("an abandoned, never-iterated stream() still holds the reservation until drained", async () => {
        const { def, release } = slowEngine()
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        // mint the wire but never iterate it — the lock reserves synchronously at call time
        const abandoned = runtime.kernel.stream({ content: "one" })

        expect(() => runtime.kernel.stream({ content: "two" })).toThrow(expect.objectContaining({ code: "AX-KERNEL-002" }))

        release()
        for await (const _ of abandoned.stream) { /* drain to release the lock */ }
        await runtime.shutdown()
    })
})

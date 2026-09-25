import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon, driver } from "../../../setup/axon"

describe("kernel failure: empty handback", () => {
    it("does not let a bare done end a live request", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "empty-handback",
            model: "empty-handback",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    if (calls === 1) {
                        yield {
                            type: "done",
                            response: {
                                text: "<done/>",
                                stopReason: "end",
                                meta: { provider: "test", model: "empty-handback", durationMs: 1 },
                            },
                        }
                        return
                    }
                    yield { type: "text:delta", content: "<text>actual reply</text><done/>" }
                    yield {
                        type: "done",
                        response: {
                            text: "<text>actual reply</text><done/>",
                            stopReason: "end",
                            meta: { provider: "test", model: "empty-handback", durationMs: 1 },
                        },
                    }
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        await expect(runtime.kernel.request({ content: "answer this" })).resolves.toBeDefined()

        expect(calls).toBe(2)
        expect(runtime.session.entries.some(entry =>
            entry.type === "cognet:output:text" && entry.data.content === "actual reply",
        )).toBe(true)

        await runtime.shutdown()
    }, 30_000)
})

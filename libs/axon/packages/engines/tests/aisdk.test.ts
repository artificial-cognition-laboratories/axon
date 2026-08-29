import { describe, expect, test } from "bun:test"
import type { AxonEngineRequest } from "@arcforge/types"
import { AiSdk } from "../src/aisdk"
import type { SdkLanguageModel, SdkStreamPart } from "../src/aisdk/types"
import { EngineFailure } from "../src/shared"

/**
 * A model that replays a fixed part list.
 *
 * The whole adapter is a translation between two shapes, so the honest test
 * is a real part sequence in and a real Axon event sequence out — no network,
 * no provider package.
 */
function model(parts: SdkStreamPart[], overrides: Partial<SdkLanguageModel> = {}): SdkLanguageModel {
    return {
        specificationVersion: "v4",
        provider: "test",
        modelId: "test-model",
        async doStream() {
            return {
                stream: new ReadableStream<SdkStreamPart>({
                    start(controller) {
                        for (const part of parts) controller.enqueue(part)
                        controller.close()
                    },
                }),
            }
        },
        ...overrides,
    }
}

const usage = {
    inputTokens: { total: 100, cacheRead: 20 },
    outputTokens: { total: 50, reasoning: 10 },
}

async function drain(
    driver: ReturnType<typeof AiSdk>,
    messages: AxonEngineRequest["messages"] = [{ role: "user", content: "hi" }],
) {
    const events = []
    for await (const event of driver.stream({ messages })) events.push(event)
    return events
}

describe("AiSdk", () => {
    test("streams text deltas and terminates with the accumulated response", async () => {
        const driver = AiSdk({
            provider: "anthropic",
            model: model([
                { type: "text-start", id: "0" },
                { type: "text-delta", id: "0", delta: "Hel" },
                { type: "text-delta", id: "0", delta: "lo" },
                { type: "text-end", id: "0" },
                { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            ]),
        })

        const events = await drain(driver)

        expect(events.map(e => e.type)).toEqual(["text:delta", "text:delta", "done"])
        const done = events.at(-1)!
        expect(done.type === "done" && done.response.text).toBe("Hello")
        expect(done.type === "done" && done.response.stopReason).toBe("end")
    })

    test("reasoning deltas surface as thinking, separate from text", async () => {
        const driver = AiSdk({
            provider: "anthropic",
            model: model([
                { type: "reasoning-delta", id: "r", delta: "thinking..." },
                { type: "text-delta", id: "0", delta: "answer" },
                { type: "finish", finishReason: { unified: "stop", raw: null as never }, usage },
            ]),
        })

        const events = await drain(driver)

        expect(events.map(e => e.type)).toEqual(["thinking:delta", "text:delta", "done"])
        const done = events.at(-1)!
        expect(done.type === "done" && done.response.thinking).toBe("thinking...")
        expect(done.type === "done" && done.response.text).toBe("answer")
    })

    test("token usage is carried through, cached and reasoning included", async () => {
        const driver = AiSdk({
            provider: "anthropic",
            model: model([
                { type: "text-delta", id: "0", delta: "x" },
                { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ]),
        })

        const done = (await drain(driver)).at(-1)!
        expect(done.type === "done" && done.response.meta.tokens).toEqual({
            in: 100, out: 50, total: 150, cachedIn: 20, reasoning: 10,
        })
    })

    test("usage the provider did not report is absent, never zero", async () => {
        const driver = AiSdk({
            provider: "anthropic",
            model: model([
                { type: "text-delta", id: "0", delta: "x" },
                {
                    type: "finish",
                    finishReason: { unified: "stop", raw: undefined },
                    usage: { inputTokens: { total: undefined }, outputTokens: { total: undefined } },
                },
            ]),
        })

        const done = (await drain(driver)).at(-1)!
        expect(done.type === "done" && done.response.meta.tokens).toBeUndefined()
    })

    test("truncation is reported as length, not as a clean finish", async () => {
        const driver = AiSdk({
            provider: "anthropic",
            model: model([
                { type: "text-delta", id: "0", delta: "cut off mid-" },
                { type: "finish", finishReason: { unified: "length", raw: "max_tokens" }, usage },
            ]),
        })

        const done = (await drain(driver)).at(-1)!
        expect(done.type === "done" && done.response.stopReason).toBe("length")
    })

    test("a content filter is a failure, not a short answer", async () => {
        const driver = AiSdk({
            provider: "anthropic",
            model: model([
                { type: "text-delta", id: "0", delta: "partial" },
                { type: "finish", finishReason: { unified: "content-filter", raw: "blocked" }, usage },
            ]),
        })

        await expect(drain(driver)).rejects.toThrow(EngineFailure)
    })

    test("a mid-stream error frame throws rather than truncating silently", async () => {
        const driver = AiSdk({
            provider: "groq",
            model: model([
                { type: "text-delta", id: "0", delta: "partial" },
                { type: "error", error: { statusCode: 429, message: "rate limited" } },
            ]),
        })

        try {
            await drain(driver)
            throw new Error("expected a throw")
        } catch (error) {
            expect(error).toBeInstanceOf(EngineFailure)
            expect((error as EngineFailure).fault.code).toBe("RATE_LIMIT")
            expect((error as EngineFailure).fault.retryable).toBe(true)
        }
    })

    test("an auth failure is not retryable", async () => {
        const driver = AiSdk({
            provider: "openai",
            model: model([{ type: "error", error: { statusCode: 401, message: "bad key" } }]),
        })

        try {
            await drain(driver)
            throw new Error("expected a throw")
        } catch (error) {
            expect((error as EngineFailure).fault.code).toBe("AUTH")
            expect((error as EngineFailure).fault.retryable).toBe(false)
        }
    })

    test("a model built against another spec version is refused at construction", () => {
        expect(() => AiSdk({
            provider: "anthropic",
            model: model([], { specificationVersion: "v2" }),
        })).toThrow(/ENGINE_SDK_VERSION/)
    })

    test("unknown stream parts are ignored, not fatal", async () => {
        const driver = AiSdk({
            provider: "anthropic",
            model: model([
                { type: "stream-start" },
                // A tag this adapter's union does not name — the point of the
                // test. Cast because the union is deliberately closed; the
                // runtime default branch is what handles it.
                { type: "some-future-part" } as unknown as SdkStreamPart,
                { type: "text-delta", id: "0", delta: "fine" },
                { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ]),
        })

        const done = (await drain(driver)).at(-1)!
        expect(done.type === "done" && done.response.text).toBe("fine")
    })

    test("an empty completion is a failure, never a valid run", async () => {
        const driver = AiSdk({
            provider: "anthropic",
            model: model([{ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }]),
        })

        await expect(drain(driver)).rejects.toThrow(/empty response/)
    })

    test("system messages stay bare strings, others become text parts", async () => {
        let seen: unknown
        const driver = AiSdk({
            provider: "anthropic",
            model: {
                specificationVersion: "v4",
                provider: "test",
                modelId: "test-model",
                async doStream(options) {
                    seen = options.prompt
                    return {
                        stream: new ReadableStream<SdkStreamPart>({
                            start(c) {
                                c.enqueue({ type: "text-delta", id: "0", delta: "ok" })
                                c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage })
                                c.close()
                            },
                        }),
                    }
                },
            },
        })

        await drain(driver, [
            { role: "system", content: "be brief" },
            { role: "user", content: "hi" },
        ])

        expect(seen).toEqual([
            { role: "system", content: "be brief" },
            { role: "user", content: [{ type: "text", text: "hi" }] },
        ])
    })

    test("effort is passed as the SDK's reasoning control", async () => {
        let seen: unknown
        const driver = AiSdk({
            provider: "anthropic",
            effort: "high",
            model: {
                specificationVersion: "v4",
                provider: "test",
                modelId: "test-model",
                async doStream(options) {
                    seen = options.reasoning
                    return {
                        stream: new ReadableStream<SdkStreamPart>({
                            start(c) {
                                c.enqueue({ type: "text-delta", id: "0", delta: "ok" })
                                c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage })
                                c.close()
                            },
                        }),
                    }
                },
            },
        })

        await drain(driver)
        expect(seen).toBe("high")
    })
})

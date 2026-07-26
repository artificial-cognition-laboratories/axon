import { EngineFailure } from "@arcforge/engines"
import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon } from "../../../setup/axon"

function response(text: string): AxonEngineRawEvent {
    return {
        type: "done",
        response: {
            text,
            stopReason: "end",
            meta: { provider: "faulty", model: "faulty", durationMs: 1 },
        },
    }
}

function retryable(message = "temporary failure") {
    return new EngineFailure({
        code: "TRANSPORT",
        message,
        retryable: true,
        provider: "faulty",
        model: "faulty",
    })
}

describe("kernel failure: engine retries", () => {
    it("surfaces an unconnected Codex subscription directly without retrying", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "codex",
            model: "gpt-test",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    throw new EngineFailure({
                        code: "AUTH_NOT_CONNECTED",
                        message: "Codex subscription not connected — run :provider codex connect and try again",
                        retryable: false,
                        provider: "codex",
                        model: "gpt-test",
                    })
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        try {
            await runtime.kernel.request({ content: "hello" })
            throw new Error("expected request to fail")
        } catch (error) {
            expect(error).toMatchObject({ code: "AX-KERNEL-012", title: "Codex Subscription Not Connected" })
            expect((error as Error).message).toContain(":provider codex connect")
        }

        expect(calls).toBe(1)
        expect(runtime.session.kernelLog.filter(e => e.type === "kernel:engine:retry")).toHaveLength(0)
        expect(runtime.session.kernelLog.find(e => e.type === "kernel:engine:failed")?.data.fault.code).toBe("AUTH_NOT_CONNECTED")

        await runtime.shutdown()
    })

    it("retries an empty pre-output response and durably correlates every attempt transition", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "faulty",
            create: () => ({
                async *stream() {
                    calls++
                    if (calls < 3) {
                        yield response("")
                        return
                    }
                    const text = "<text>recovered</text><done/>"
                    yield { type: "text:delta", content: text }
                    yield response(text)
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        await expect(runtime.kernel.request({ content: "hello" })).resolves.toBeDefined()

        expect(calls).toBe(3)
        const events = runtime.session.kernelLog.filter(e => e.type.startsWith("kernel:engine:"))
        expect(events.map(e => e.type)).toEqual([
            "kernel:engine:start",
            "kernel:engine:input",
            "kernel:engine:retry",
            "kernel:engine:retry",
            "kernel:engine:complete",
        ])
        expect(new Set(events.map(e => e.context.spanId)).size).toBe(1)
        expect(new Set(events.map(e => e.context.runId)).size).toBe(1)
        const input = events.find(e => e.type === "kernel:engine:input")
        expect(input?.data.bytes).toBeGreaterThan(0)
        const complete = events.find(e => e.type === "kernel:engine:complete")
        expect(complete?.data.attempts).toBe(3)

        await runtime.shutdown()
    })

    it("does not retry after semantic output has crossed the engine boundary", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "faulty",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    yield { type: "text:delta", content: "<text>partial" }
                    throw retryable()
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        await expect(runtime.kernel.request({ content: "hello" })).rejects.toThrow(/temporary failure/)

        expect(calls).toBe(1)
        expect(runtime.session.kernelLog.filter(e => e.type === "kernel:engine:retry")).toHaveLength(0)
        const failed = runtime.session.kernelLog.find(e => e.type === "kernel:engine:failed")
        expect(failed?.data.attempts).toBe(1)
        expect(failed?.data.fault.code).toBe("TRANSPORT")

        await runtime.shutdown()
    })

    it("can retry after reasoning-only output because no semantic action crossed the boundary", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "faulty",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    if (calls === 1) {
                        yield { type: "thinking:delta", content: "considering" }
                        throw retryable("reasoning stream died")
                    }
                    const text = "<text>recovered</text><done/>"
                    yield { type: "text:delta", content: text }
                    yield response(text)
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        await expect(runtime.kernel.request({ content: "hello" })).resolves.toBeDefined()

        expect(calls).toBe(2)
        expect(runtime.session.kernelLog.filter(e => e.type === "kernel:engine:retry")).toHaveLength(1)

        await runtime.shutdown()
    })

    it("bounds retryable pre-output failures at three attempts and records the terminal fault", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "faulty",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    throw retryable("still down")
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        await expect(runtime.kernel.request({ content: "hello" })).rejects.toThrow(/still down/)

        expect(calls).toBe(3)
        expect(runtime.session.kernelLog.filter(e => e.type === "kernel:engine:retry")).toHaveLength(2)
        const failed = runtime.session.kernelLog.find(e => e.type === "kernel:engine:failed")
        expect(failed?.data.attempts).toBe(3)

        await runtime.shutdown()
    })

    it("reconciles against the driver's authoritative final text when streamed deltas under-deliver it", async () => {
        // Reproduces a real Codex-shaped failure: text:delta chunks stop
        // short of the closing tags (dropped/truncated on the wire), but the
        // driver's terminal done.response.text — sourced from the provider's
        // own authoritative output_text.done — has the complete, correctly
        // closed block. Without reconciliation the parser would report
        // INCOMPLETE_BLOCK against data that was never truly incomplete.
        const complete = '<typescript>1 + 1</typescript><done/>'
        const truncated = complete.slice(0, complete.indexOf("</typescript>") + 3) // "...</typ"

        let calls = 0
        const def: AxonEngineDef = {
            name: "truncated-stream",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    if (calls === 1) {
                        yield { type: "text:delta", content: truncated }
                        yield response(complete)
                        return
                    }
                    const text = "<text>done</text><done/>"
                    yield { type: "text:delta", content: text }
                    yield response(text)
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        await runtime.axon.request("/go")
        const thread = await runtime.kernel.thread(".")

        expect(thread.entries.some(e => e.type === "agent:output:error")).toBe(false)
        expect(thread.entries.some(e => e.type === "agent:typescript" && e.data.content === "1 + 1")).toBe(true)

        await runtime.shutdown()
    })
})

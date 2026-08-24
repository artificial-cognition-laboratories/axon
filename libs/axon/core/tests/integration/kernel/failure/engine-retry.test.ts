import { EngineFailure } from "@arcforge/engines"
import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"
import { Axon, driver } from "../../../setup/axon"

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
    /**
     * The behaviour here is unchanged — an unconnected provider must not be
     * retried, and must reach the user as something they can act on. What
     * changed is that it is no longer CODEX-specific.
     *
     * This was the kernel's one hand-written special case (`AUTH_NOT_CONNECTED`
     * AND `provider === "codex"`), so every other route hit a generic internal
     * error for the identical condition. `ENGINE_NOT_CONNECTED` now covers any
     * provider, with the driver's own message naming which one — see
     * engine-fault-classification.test.ts for the full mapping.
     */
    it("surfaces an unconnected provider directly without retrying", async () => {
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
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        try {
            await runtime.kernel.request({ content: "hello" })
            throw new Error("expected request to fail")
        } catch (error) {
            expect(error).toMatchObject({ code: "AX-KERNEL-015", title: "Provider Not Connected" })
            // The driver's own sentence still reaches the user — it is the part
            // that names the provider and the exact command to run.
            expect((error as Error).message).toContain(":provider codex connect")
            // ...and it renders without our stack: the user's account is not
            // connected, which is not a bug in code they can read.
            expect((error as { expected?: boolean }).expected).toBe(true)
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
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        await expect(runtime.kernel.request({ content: "hello" })).resolves.toBeDefined()

        expect(calls).toBe(3)
        const events = runtime.session.kernelLog.filter(e => e.type.startsWith("kernel:engine:"))
        // firstToken appears ONCE, before :complete — not once per attempt.
        // The first two attempts yield nothing but `done` (that is what makes
        // them empty responses), so no provider delta ever crosses and there is
        // no first token to mark. Only the third attempt streams text. The
        // marker tracks real token flow, not attempt count.
        expect(events.map(e => e.type)).toEqual([
            "kernel:engine:start",
            "kernel:engine:input",
            "kernel:engine:retry",
            "kernel:engine:retry",
            "kernel:engine:firstToken",
            "kernel:engine:complete",
        ])
        const firstToken = events.find(e => e.type === "kernel:engine:firstToken")
        expect(firstToken?.data.attempt).toBe(3)
        expect(new Set(events.map(e => e.context.spanId)).size).toBe(1)
        expect(new Set(events.map(e => e.context.runId)).size).toBe(1)
        const input = events.find(e => e.type === "kernel:engine:input")
        expect(input?.data.bytes).toBeGreaterThan(0)
        const complete = events.find(e => e.type === "kernel:engine:complete")
        expect(complete?.data.attempts).toBe(3)

        await runtime.shutdown()
    })

    /**
     * An OPENED block is not output. `<text>partial` with no closing tag
     * emits `text:open`, which sets the block's language and nothing else
     * — no `engine:text`, so nothing reaches the session or the user.
     *
     * This used to forfeit the retry, on the reading that any non-blank delta
     * meant output had escaped. It had not: the caller was left with a fault
     * and a truncated reply nobody could see, when a second attempt would have
     * cost one call and produced a real answer. A stalled stream hits this
     * exact path, which is how it was found.
     *
     * What still forfeits a retry is output that genuinely crossed — a delta
     * inside a block, or a completed one. That is the case below.
     */
    it("retries when a block was opened but nothing crossed the boundary", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "faulty",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    if (calls === 1) {
                        yield { type: "text:delta", content: "<text>partial" }
                        throw retryable()
                    }
                    const text = "<text>recovered</text><done/>"
                    yield { type: "text:delta", content: text }
                    yield response(text)
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        await expect(runtime.kernel.request({ content: "hello" })).resolves.toBeDefined()
        expect(calls).toBe(2)

        await runtime.shutdown()
    })

    it("does not retry after semantic output has crossed the engine boundary", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "faulty",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    // A closed block: this one really did reach the consumer,
                    // so re-running would duplicate it.
                    yield { type: "text:delta", content: "<text>said out loud</text>" }
                    throw retryable()
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

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
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

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
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

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
        const complete = '<script>1 + 1</script><done/>'
        const truncated = complete.slice(0, complete.indexOf("</script>") + 3) // "...</typ"

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
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        await runtime.axon.request("/go")

        // kernel.thread() is gone with the thread concept itself — one runtime
        // is always exactly one continuous stream, so the session's entry log
        // IS the record. Event names moved from agent:* to cognet:* in the
        // same change (see engine-error.test.ts for the current form).
        expect(runtime.session.entries.some(e => e.type === "cognet:output:error")).toBe(false)
        expect(runtime.session.entries.some(e => e.type === "cognet:action:typescript" && e.data.content === "1 + 1")).toBe(true)

        await runtime.shutdown()
    })
})

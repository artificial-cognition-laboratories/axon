import { Axon } from "../../../setup/axon"
import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"

/**
 * An engine whose stream() blocks on the FIRST call until interrupted via
 * the request's abort signal, then behaves normally on every call after —
 * so a test can prove the lock releases and a fresh run goes through.
 *
 * Signals `entered` once the first call has actually started, so a test can
 * wait for the run to truly be in-flight before calling interrupt(). Without
 * this, interrupt() could fire before the loop has even reached the engine
 * call (Execution/AbortController not constructed yet), in which case it's
 * a documented no-op and the run would hang forever.
 */
function hangingEngine() {
    let markEntered: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    let firstCall = true

    const def: AxonEngineDef = {
        name: "hanging",
        create: () => ({
            async *stream(req): AsyncGenerator<AxonEngineRawEvent> {
                if (firstCall) {
                    firstCall = false
                    markEntered()
                    await new Promise<void>((resolve, reject) => {
                        req.signal?.addEventListener("abort", () => reject(new Error("aborted")))
                    })
                    return
                }

                // Real AIR-tagged text — a bare delta with no <done/> would
                // never signal the loop's stop condition (the parser only
                // sees literal grammar tags, not response.text).
                const text = "<text>ok</text><done/>"
                yield { type: "text:delta", content: text }
                yield {
                    type: "done",
                    response: {
                        text,
                        stopReason: "end",
                        meta: { provider: "hanging", model: "hanging", tokens: { in: 0, out: 0, total: 0 }, durationMs: 0 },
                    },
                }
            },
        }),
    }
    return { def, entered }
}

/**
 * An engine whose first stream() call throws a retryable fault, so the
 * kernel enters its retry-backoff delay — then never gets a second call:
 * the test interrupts during that delay window instead. Proves the
 * abort-during-backoff path (kernel/engine.ts's inner delay() catch) is
 * recognized as cancellation, not wrapped into ENGINE_STREAM_FAILED.
 *
 * Must throw a TypeError specifically — asEngineFault() (shared/fault.ts)
 * only classifies TypeError/SyntaxError as retryable; a bare Error is
 * UNKNOWN/non-retryable and never reaches the backoff delay at all, which
 * would test the wrong branch entirely (the already-correct outer catch,
 * not the inner delay() catch this test exists to cover).
 */
function retryingEngine() {
    let markEntered: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })

    const def: AxonEngineDef = {
        name: "retrying",
        create: () => ({
            async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                markEntered()
                throw new TypeError("upstream hiccup")
            },
        }),
    }
    return { def, entered }
}

describe("kernel failure: interrupt", () => {
    it("interrupting during retry backoff is cancellation, not an engine failure", async () => {
        const { def, entered } = retryingEngine()
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        const pending = runtime.kernel.request({ content: "hello" })
        await entered
        runtime.kernel.interrupt()
        await pending

        expect(runtime.session.kernelLog.some(e => e.type === "kernel:engine:failed")).toBe(false)
        expect(runtime.session.kernelLog.some(e => e.type === "kernel:run:interrupted")).toBe(true)

        await runtime.shutdown()
    })


    it("interrupt() while a run is in-flight ends the run rather than hanging", async () => {
        const { def, entered } = hangingEngine()
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        const pending = runtime.kernel.request({ content: "hello" })
        await entered
        runtime.kernel.interrupt()

        await expect(pending).resolves.toBeDefined()

        await runtime.shutdown()
    })

    it("interrupt() commits a axon:interrupt entry to the session", async () => {
        const { def, entered } = hangingEngine()
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        const pending = runtime.kernel.request({ content: "hello" })
        await entered
        runtime.kernel.interrupt()
        await pending

        const interrupted = runtime.session.entries.find(e => e.type === "axon:interrupt")

        expect(interrupted).toBeDefined()
        expect((interrupted!.data as { reason: string }).reason).toBe("user")

        await runtime.shutdown()
    })

    it("does not record an engine failure for an intentional interrupt", async () => {
        const { def, entered } = hangingEngine()
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        const pending = runtime.kernel.request({ content: "hello" })
        await entered
        runtime.kernel.interrupt()
        await pending

        expect(runtime.session.kernelLog.some(e => e.type === "kernel:engine:failed")).toBe(false)
        expect(runtime.session.kernelLog.some(e => e.type === "kernel:run:interrupted")).toBe(true)

        await runtime.shutdown()
    })

    it("interrupt() when idle is a safe no-op", async () => {
        const runtime = await Axon()

        expect(() => runtime.kernel.interrupt()).not.toThrow()

        await runtime.shutdown()
    })

    it("the lock releases after an interrupted run — a fresh run is accepted afterward", async () => {
        const { def, entered } = hangingEngine()
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        const pending = runtime.kernel.request({ content: "hello" })
        await entered
        runtime.kernel.interrupt()
        await pending

        await expect(runtime.kernel.request({ content: "again" })).resolves.toBeDefined()

        await runtime.shutdown()
    })
})

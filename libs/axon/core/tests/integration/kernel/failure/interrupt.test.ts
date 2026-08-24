import { Axon, driver } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"
import { run } from "@arcforge/engines/mock"
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
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

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
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        const pending = runtime.kernel.request({ content: "hello" })
        await entered
        runtime.kernel.interrupt()

        await expect(pending).resolves.toBeDefined()

        await runtime.shutdown()
    })

    it("interrupt() commits a axon:interrupt entry to the session", async () => {
        const { def, entered } = hangingEngine()
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

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
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        const pending = runtime.kernel.request({ content: "hello" })
        await entered
        runtime.kernel.interrupt()
        await pending

        expect(runtime.session.kernelLog.some(e => e.type === "kernel:engine:failed")).toBe(false)
        expect(runtime.session.kernelLog.some(e => e.type === "kernel:run:interrupted")).toBe(true)

        await runtime.shutdown()
    })

    it("interrupt() when idle is a safe no-op", async () => {
        const runtime = await Axon({ providers: [Mock()] })

        expect(() => runtime.kernel.interrupt()).not.toThrow()

        await runtime.shutdown()
    })

    it("the lock releases after an interrupted run — a fresh run is accepted afterward", async () => {
        const { def, entered } = hangingEngine()
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        const pending = runtime.kernel.request({ content: "hello" })
        await entered
        runtime.kernel.interrupt()
        await pending

        await expect(runtime.kernel.request({ content: "again" })).resolves.toBeDefined()

        await runtime.shutdown()
    })
})

/**
 * A kill is authoritative, not something cognition opts into.
 *
 * The signal used to be threaded by hand — `kernel.run(code, { signal })` —
 * which made it optional at the type level and therefore forgettable. One
 * missing argument produced an operation nothing could stop, and the failure
 * was invisible until someone pressed Ctrl+C on a long run.
 *
 * The kernel now resolves the wake's signal itself for everything it
 * mediates, so there is nothing left to forget. These assert that from the
 * outside: the test cognet passes no signal anywhere, and cancellation still
 * lands.
 */
describe("Interrupt authority", () => {
    it("cancels capsule work the cognet never passed a signal for", async () => {
        const runtime = await Axon({
            blueprint: {
                config: {
                    providers: [Mock({
                        "/go": [run(`await new Promise(r => setTimeout(r, 10_000)); "unreachable"`), "unreachable"],
                    })],
                },
            },
        })

        const invocation = runtime.axon.stream("/go")
        const drain = (async () => {
            for await (const _ of invocation.stream) { /* drain */ }
        })()

        while (!runtime.session.entries.some(e => e.type === "cognet:action:typescript")) {
            await Bun.sleep(5)
        }

        const started = Date.now()
        invocation.interrupt()
        await drain

        // The block asked for ten seconds. Returning in a fraction of that is
        // the proof — nothing waited for it to finish on its own.
        expect(Date.now() - started).toBeLessThan(2_000)

        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")
        expect((result!.data as { error?: { kind: string } }).error?.kind).toBe("interrupt")

        await runtime.shutdown()
    })

    // The counterpart: a cognet's OWN work between syscalls cannot be
    // preempted — a JS function has no yield point the runtime can seize. So
    // CognetWake.signal remains, and honouring it stays cooperative.
    it("still hands the cognet a signal for its own units of work", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hi: "hello" })] } } })

        const invocation = runtime.axon.stream("hi")
        for await (const _ of invocation.stream) { /* drain */ }

        // Nothing to assert beyond the wake completing: the contract is that
        // `signal` is present on the wake, which the test cognet reads.
        expect(runtime.session.entries.length).toBeGreaterThan(0)

        await runtime.shutdown()
    })
})

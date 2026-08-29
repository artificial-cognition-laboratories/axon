import { Axon as AxonRuntime } from "@arcforge/core"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { KernelAbi } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"

/**
 * Tearing down a brain that drives its own clock.
 *
 * A continuous cognet is ticked by one of its own plugins calling
 * kernel.wake() on an interval, and that interval is cleared by the plugin's
 * "shutdown" hook — which runs inside cognet.unload(). So the clock is still
 * firing while shutdown is in progress, and everything it touches must stay
 * valid until unload() has finished stopping it.
 *
 * This is not theoretical. The teardown used to detach the scheduler BEFORE
 * unloading, so wake() threw NO_COGNET_LOADED into a 30Hz interval for the
 * whole duration — an unhandled rejection every ~33ms, from a plugin doing
 * exactly what the authoring surface tells it to do. A dependency that
 * installs a process-level unhandledRejection handler (phonemizer, via vox's
 * TTS) turns each of those into a fatal throw, which killed the host.
 */

/** A continuous brain whose clock keeps ticking until its shutdown hook stops it. */
function TickingCognet(opts: { onWakeError: (error: unknown) => void; hz: number }) {
    let kernel: KernelAbi | null = null
    let clock: ReturnType<typeof setInterval> | null = null

    return defineCognet({
        name: "ticking",
        version: "1.0.0",
        abi: KERNEL_ABI_VERSION,
        mode: { kind: "continuous" },

        load(abi) {
            kernel = abi
            // Exactly the shape a real continuous cognet's wake plugin uses:
            // fire-and-forget, because wake() resolves on admission.
            clock = setInterval(() => {
                try {
                    const admitted = kernel!.wake() as Promise<number> | undefined
                    admitted?.catch?.(opts.onWakeError)
                } catch (error) {
                    // wake() throws SYNCHRONOUSLY once the scheduler is
                    // detached, which is precisely what `void kernel.wake()`
                    // in a real plugin cannot catch — the rejection escapes to
                    // the process and a global unhandledRejection handler
                    // turns it fatal.
                    opts.onWakeError(error)
                }
            }, 1000 / opts.hz)
        },

        async wake() {
            // Nothing to deliberate — the clock itself is what is under test.
        },

        async unload() {
            // Unload takes real time — a shutdown hook awaits I/O, a model
            // unloads, a device closes. This is what holds the window open
            // long enough for the clock to fire into it, and an instant
            // unload would let the bug pass unnoticed.
            await Bun.sleep(30)
            // The brain stops its own clock, exactly as the wake plugin does
            // via its "shutdown" hook.
            if (clock) clearInterval(clock)
            clock = null
        },
    })
}

describe("Continuous cognet teardown", () => {
    it("never faults its own clock while shutting down", async () => {
        const errors: unknown[] = []
        const runtime = await AxonRuntime({
            blueprint: {
                cognet: {
                    name: "ticking",
                    version: "1.0.0",
                    abi: KERNEL_ABI_VERSION,
                    definition: TickingCognet({ onWakeError: e => errors.push(e), hz: 200 }),
                },
            },
        })

        // Let the clock run long enough to be mid-flight at teardown.
        await Bun.sleep(60)
        await runtime.shutdown()
        // Anything still queued would land just after shutdown resolves.
        await Bun.sleep(40)

        expect(errors).toEqual([])
    })

    it("stops the clock rather than leaving it firing after shutdown", async () => {
        let wakes = 0
        let kernel: KernelAbi | null = null
        let clock: ReturnType<typeof setInterval> | null = null

        const runtime = await AxonRuntime({
            blueprint: {
                cognet: {
                    name: "counting",
                    version: "1.0.0",
                    abi: KERNEL_ABI_VERSION,
                    definition: defineCognet({
                        name: "counting",
                        version: "1.0.0",
                        abi: KERNEL_ABI_VERSION,
                        mode: { kind: "continuous" },
                        load(abi) {
                            kernel = abi
                            clock = setInterval(() => { try { void kernel!.wake() } catch { /* counted below */ } }, 5)
                        },
                        async wake() { wakes++ },
                        async unload() { if (clock) clearInterval(clock); clock = null },
                    }),
                },
            },
        })

        await Bun.sleep(50)
        await runtime.shutdown()
        const afterShutdown = wakes
        await Bun.sleep(40)

        // The clock is genuinely stopped — not merely erroring quietly.
        expect(wakes).toBe(afterShutdown)
        expect(afterShutdown).toBeGreaterThan(0)
    })
})

import { err } from "@arcforge/err"

export type PulseOpts = {
    /** Wakes per second — the continuous mind's `mode.hz`. */
    hz: number
    /** Ask for a wake. Resolves on admission, never on completion. */
    wake(): Promise<unknown>
    /** Where a refused wake is reported. The pulse stops after reporting. */
    refused(cause: unknown): void
}

/**
 * Pulse — a continuous mind's clock.
 *
 * Drives `kernel.wake()` at the mind's own rate. Fire-and-forget by design:
 * `wake()` resolves when the wake is ADMITTED, so awaiting it would make a
 * slow wake suppress the next — and overlap is the kernel's policy to decide,
 * not the clock's.
 *
 * A refused wake is not dropped. The kernel refuses only when no cognet is
 * attached, which means the clock has outlived its brain — so the pulse
 * reports it once and stops, rather than raising the same refusal `hz` times a
 * second.
 */
export function Pulse(opts: PulseOpts) {
    if (!Number.isFinite(opts.hz) || opts.hz <= 0) {
        throw err("COGNET_INVALID", { detail: `mode.hz must be a positive number of wakes per second, got ${opts.hz}` })
    }
    let timer: ReturnType<typeof setInterval> | null = null

    function stop(): void {
        if (timer) clearInterval(timer)
        timer = null
    }

    return {
        start(): void {
            if (timer) return
            timer = setInterval(() => {
                // Through a promise so a SYNCHRONOUS refusal is caught too —
                // thrown inside a timer, it would escape as an uncaught error.
                Promise.resolve().then(() => opts.wake()).catch(cause => {
                    stop()
                    opts.refused(cause)
                })
            }, 1000 / opts.hz)
        },

        stop: stop,
    }
}

export type PulseT = ReturnType<typeof Pulse>

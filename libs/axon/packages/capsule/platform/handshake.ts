import { err } from "@arcforge/err"
import type { CapsuleBusT } from "./bus"

type HandshakeOpts = {
    bus: CapsuleBusT
    timeoutMs: number
    /** Crash context supplier — the wire's stderr ring. */
    stderr(): string
}

/**
 * Wait for the subprocess boot handshake: capsule:boot:complete on the bus,
 * racing boot:failed, early exit, and the timeout. Every failure path rejects
 * with a coded err() carrying the stderr ring as structured context — "the
 * capsule wouldn't boot" must classify AND carry why, never surface as an
 * unclassified AX-UNKNOWN error.
 */
export function handshake(opts: HandshakeOpts): Promise<void> {
    const { bus, timeoutMs } = opts

    return new Promise<void>((resolve, reject) => {
        const offs: Array<() => void> = []

        function settle(fn: () => void) {
            clearTimeout(timer)
            for (const off of offs) off()
            fn()
        }

        /**
         * Reject with a coded error; the stderr ring rides along as context.
         * `cause` carries the guest's own structured failure when there is
         * one — the boot error it reported over the wire — so the report
         * renders the sandbox's stack, not just this host-side wrapper.
         */
        function fail(code: "CAPSULE_BOOT_FAILED" | "CAPSULE_BOOT_TIMEOUT", reason: string, cause?: unknown) {
            const stderr = opts.stderr().trim()
            settle(() => reject(err(code, {
                context: stderr ? { reason, stderr } : { reason },
                ...(cause !== undefined ? { cause } : {}),
            })))
        }

        const timer = setTimeout(() => {
            fail("CAPSULE_BOOT_TIMEOUT", `subprocess not ready within ${timeoutMs}ms`)
        }, timeoutMs)

        offs.push(
            bus.on("capsule:boot:complete", () => settle(resolve)),
            bus.on("capsule:boot:failed", e => fail("CAPSULE_BOOT_FAILED", e.error.message, e.error)),
            bus.on("capsule:exit", e => fail("CAPSULE_BOOT_FAILED", `subprocess exited (code ${e.code ?? "unknown"}) before ready`)),
        )
    })
}

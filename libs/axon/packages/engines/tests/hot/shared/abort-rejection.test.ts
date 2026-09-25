import { readSse } from "../../../src/shared"
import { describe, it, expect } from "bun:test"

/**
 * Aborting a stream must not reject anything nobody is holding.
 *
 * ── The incident ────────────────────────────────────────────────────────────
 *
 * Pressing Escape in the TUI replaced a running terminal with
 * `Runtime Error / The operation was aborted.` — VTerm's fatal boundary
 * catching an UNHANDLED rejection, not a failure anything rendered.
 *
 * The reported stack was `abort → x → receive → data`: the link's channel
 * dispatching an abort frame off the socket, and the rejection happening
 * SYNCHRONOUSLY inside `controller.abort()`. That is only possible from an
 * abort listener, and the listener was this one:
 *
 *     const onAbort = () => { void reader.cancel() }
 *
 * `cancel()` returns a promise, and cancelling a reader whose stream the
 * transport has already errored rejects it. `void` discarded the promise, so
 * the rejection had no handler and no caller.
 *
 * ── Why it survived every suite ─────────────────────────────────────────────
 *
 * Nothing about the OUTPUT was wrong. The consumer still saw the abort, the
 * stream still ended, and every assertion about what `readSse` yields held.
 * The defect was a promise nobody was looking at, which only shows up as a
 * process-level event — so a test has to listen for one.
 *
 * The same line existed three times (`sse.ts`, `ndjson.ts`, cloud's
 * `engine.ts`), which is the usual shape: one idea copied before it was known
 * to be wrong.
 */

/** A body that errors the way a real transport does when its request aborts. */
function abortingBody(signal: AbortSignal): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const timer = setInterval(
                () => controller.enqueue(new TextEncoder().encode("data: {\"type\":\"tick\"}\n\n")),
                20,
            )
            signal.addEventListener("abort", () => {
                clearInterval(timer)
                controller.error(new DOMException("The operation was aborted.", "AbortError"))
            })
        },
    })
    return new Response(stream)
}

describe("aborting an SSE read", () => {
    it("leaves no unhandled rejection behind", async () => {
        const unhandled: string[] = []
        const onUnhandled = (reason: unknown) => unhandled.push(String(reason))
        process.on("unhandledRejection", onUnhandled)

        const controller = new AbortController()
        try {
            setTimeout(() => controller.abort(), 60)

            // The consumer's own failure is expected and is NOT the bug — an
            // aborted read rejects for whoever is awaiting it, which is right.
            await (async () => {
                try {
                    for await (const _ of readSse(abortingBody(controller.signal), controller.signal)) {
                        // drain
                    }
                } catch {
                    // The caller sees it. That is the contract.
                }
            })()

            // Give any floating promise a turn to reject.
            await Bun.sleep(300)

            expect(unhandled).toEqual([])
        } finally {
            process.off("unhandledRejection", onUnhandled)
        }
    }, 30_000)
})

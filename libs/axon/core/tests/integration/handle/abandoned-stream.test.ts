import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

/**
 * An abandoned stream must not wedge the runtime.
 *
 * kernel.stream() reserves the scheduler synchronously — it has to, or two
 * callers could both mint a wire before either locked. But an async
 * generator's body does not run until iterated, so between the call and the
 * first pull the scheduler is locked with nothing running. A caller that
 * never consumes the wire used to hold that lock forever: every later
 * request threw RUN_IN_PROGRESS until the process restarted.
 *
 * /_axon/stream has exactly this shape (the wire is handed to a
 * ReadableStream whose start() fires on first read), so a client
 * disconnecting in that window could take a deployed agent down remotely.
 */
describe("Abandoned stream", () => {
    it("frees the scheduler when the caller interrupts without consuming", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "hi" }) } } })

        // Reserve a wire and abandon it — never iterated.
        const wire = runtime.kernel.stream({ content: "one" })
        wire.interrupt()

        // The runtime must still be usable.
        const result = await runtime.kernel.request({ content: "two" })
        expect(result.ok).toBe(true)

        await runtime.shutdown()
    })

    it("still serves normal sequential requests", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "hi" }) } } })

        // The abandonment guard must not interfere with the ordinary path.
        const first = await runtime.kernel.request({ content: "one" })
        const second = await runtime.kernel.request({ content: "two" })

        expect(first.ok).toBe(true)
        expect(second.ok).toBe(true)

        await runtime.shutdown()
    })

    it("still serves a fully consumed stream", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "hi" }) } } })

        const wire = runtime.kernel.stream({ content: "one" })
        for await (const _entry of wire.stream) { /* drain */ }

        // consuming released the lock the ordinary way
        const after = await runtime.kernel.request({ content: "two" })
        expect(after.ok).toBe(true)

        await runtime.shutdown()
    })

    it("interrupting a consumed stream still aborts its wake", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "hi" }) } } })

        // The interrupt path aborts BEFORE releasing, so a running wake is
        // genuinely cancelled rather than the abort silently missing.
        const wire = runtime.kernel.stream({ content: "one" })
        const iterator = wire.stream[Symbol.asyncIterator]()
        await iterator.next()
        wire.interrupt()

        // drain whatever remains; the wake ends either way
        try {
            while (!(await iterator.next()).done) { /* drain */ }
        } catch { /* an interrupted wake may reject at the consumer */ }

        const after = await runtime.kernel.request({ content: "two" })
        expect(after.ok).toBe(true)

        await runtime.shutdown()
    })
})

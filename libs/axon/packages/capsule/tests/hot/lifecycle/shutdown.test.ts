import { Capsule } from "@arcforge/capsule"

describe("Capsule shutdown", () => {
    it("shuts down cleanly and rejects further runs", async () => {
        const capsule = Capsule()

        await capsule.boot()
        await capsule.shutdown()

        await expect(capsule.run("1")).rejects.toThrow()
    })

    it("is idempotent — shutting down twice does not throw", async () => {
        const capsule = Capsule()

        await capsule.boot()

        await capsule.shutdown()
        await capsule.shutdown()
    })

    it("rejects an in-flight run promptly instead of hanging when shutdown happens mid-run", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const pending = capsule.run("await new Promise(r => setTimeout(r, 60_000))")

        // kill() sends SIGTERM (async) — without emitting capsule:exit itself,
        // shutdown() used to detach the exit listener before the real OS exit
        // event ever fired, leaving in-flight runs hanging forever.
        await capsule.shutdown()

        await expect(pending).rejects.toThrow(/capsule exited during run/)
    })
})

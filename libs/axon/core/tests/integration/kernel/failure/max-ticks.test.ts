import { Axon } from "../../../setup/axon"
import { Mock, run } from "@arcforge/engines/mock"

describe("kernel failure: MAX_TICKS bound", () => {
    it("a def that never reaches a stop condition fails with a bounded-run error rather than hanging", async () => {
        // always executes, never speaks — the loop keeps re-invoking the engine forever
        const runtime = await Axon({
            blueprint: { config: { engine: Mock(() => run("return 1")) } },
        })

        await expect(runtime.kernel.request({ content: "go" })).rejects.toThrow(/MAX_TICKS/)

        await runtime.shutdown()
    })

    it("the lock releases after a MAX_TICKS failure — a fresh run is accepted afterward", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock(() => run("return 1")) } },
        })

        await expect(runtime.kernel.request({ content: "go" })).rejects.toThrow()

        // same never-terminating engine, so this run also hits MAX_TICKS — the
        // point is that it's REJECTED again (lock released, run accepted),
        // not silently blocked by a stale RUN_IN_PROGRESS from the first failure
        await expect(runtime.kernel.request({ content: "go again" })).rejects.toThrow(/MAX_TICKS/)

        await runtime.shutdown()
    })

    it("commits kernel:run:failed rather than silently swallowing the bound violation", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock(() => run("return 1")) } },
        })

        await expect(runtime.kernel.request({ content: "go" })).rejects.toThrow()

        // the run failed before producing a final cognet:output:text — nothing pretends the task completed
        expect(runtime.session.entries.some(e => e.type === "cognet:output:text")).toBe(false)
        // Every failed wake crosses into the user-visible session channel,
        // even when the error originated in an isolated bundled cognet whose
        // private @axon/err sink cannot see this runtime's AsyncLocalStorage.
        expect(runtime.session.log.filter(e => e.type === "axon:error")).toHaveLength(1)

        await runtime.shutdown()
    })
})

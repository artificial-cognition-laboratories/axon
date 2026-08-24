import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

describe("Axon shutdown", () => {
    it("commits axon:shutdown:start then axon:shutdown:complete to the session log", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi" })] } },
        })

        await runtime.shutdown()

        const types = runtime.session.log.map(e => e.type)
        const start = types.indexOf("axon:shutdown:start")
        const complete = types.indexOf("axon:shutdown:complete")

        expect(start).toBeGreaterThan(-1)
        expect(complete).toBeGreaterThan(start)
    })

    it("axon:shutdown:complete carries a non-negative durationMs", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi" })] } },
        })

        await runtime.shutdown()

        const complete = runtime.session.log.find(e => e.type === "axon:shutdown:complete")
        expect(complete).toBeDefined()
        expect((complete!.data as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0)
    })

    it("commits axon:session:closed as part of shutdown", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi" })] } },
        })

        await runtime.shutdown()

        const end = runtime.session.log.find(e => e.type === "axon:session:closed")
        expect(end).toBeDefined()
    })

    it("shutdown accepts an optional reason and records it on axon:shutdown:start", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi" })] } },
        })

        await runtime.shutdown("test teardown")

        const start = runtime.session.log.find(e => e.type === "axon:shutdown:start")
        expect(start).toBeDefined()
        expect((start!.data as { reason?: string }).reason).toBe("test teardown")
    })
})

import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

/**
 * cognet:load:* / cognet:unload:* are the artifact's lifecycle bracket.
 * They are committed by the KERNEL, not the brain — a cognet that dies
 * inside load() could never close a bracket it opened itself — and land in
 * the kernel telemetry view like every other cognet:* event.
 */
describe("Cognet lifecycle", () => {
    it("brackets load with start then complete during boot", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi" }) } },
        })

        const types = runtime.session.kernelLog.map(e => e.type)
        const start = types.indexOf("cognet:load:start")
        const complete = types.indexOf("cognet:load:complete")

        expect(start).toBeGreaterThan(-1)
        expect(complete).toBeGreaterThan(start)

        await runtime.shutdown()
    })

    it("cognet:load:complete carries the artifact name and a duration", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi" }) } },
        })

        const complete = runtime.session.kernelLog.find(e => e.type === "cognet:load:complete")
        expect(complete).toBeDefined()

        const data = complete!.data as { name: string; durationMs: number }
        expect(data.name).toBe("test")
        expect(data.durationMs).toBeGreaterThanOrEqual(0)

        await runtime.shutdown()
    })

    it("brackets unload with start then complete during shutdown", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi" }) } },
        })

        await runtime.shutdown()

        const types = runtime.session.kernelLog.map(e => e.type)
        const start = types.indexOf("cognet:unload:start")
        const complete = types.indexOf("cognet:unload:complete")

        expect(start).toBeGreaterThan(-1)
        expect(complete).toBeGreaterThan(start)
    })

    it("loads before the first wake and unloads after it", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi" }) } },
        })

        await runtime.kernel.request({ content: "hello" })
        await runtime.shutdown()

        const types = runtime.session.kernelLog.map(e => e.type)
        const load = types.indexOf("cognet:load:complete")
        const run = types.indexOf("kernel:run:start")
        const unload = types.indexOf("cognet:unload:start")

        expect(load).toBeGreaterThan(-1)
        expect(run).toBeGreaterThan(load)
        expect(unload).toBeGreaterThan(run)
    })
})

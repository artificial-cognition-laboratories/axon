import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"
import type { CognetDefinition } from "@arcforge/types"
import { KERNEL_ABI_VERSION } from "@arcforge/types"

describe("kernel reload: session log record", () => {
    it("update() commits axon:reload:start then axon:reload:complete to the session log", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "v1" })] } },
        })

        await runtime.update({ config: { providers: [Mock({ hello: "v2" })] } })

        const types = runtime.session.log.map(e => e.type)
        const start = types.indexOf("axon:reload:start")
        const complete = types.indexOf("axon:reload:complete")

        expect(start).toBeGreaterThan(-1)
        expect(complete).toBeGreaterThan(start)

        const event = runtime.session.log.find(e => e.type === "axon:reload:complete")!
        const data = event.data as { revision: number; durationMs: number; toolCount: number }
        expect(data.revision).toBe(1)
        expect(data.durationMs).toBeGreaterThanOrEqual(0)
        expect(typeof data.toolCount).toBe("number")

        const reloads = runtime.session.entries.filter(e => e.type === "axon:system:message" && e.data.type === "hot-reload")
        expect(reloads).toHaveLength(1)
        expect(reloads[0]!.data).toMatchObject({
            type: "hot-reload",
            lang: "txt",
            attributes: { revision: "1" },
        })

        await runtime.shutdown()
    })

    it("axon:boot:complete is a durable session-log fact, not just a bus notification", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi" })] } },
        })

        const boot = runtime.session.log.find(e => e.type === "axon:boot:complete")
        expect(boot).toBeDefined()
        expect((boot!.data as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0)

        await runtime.shutdown()
    })

    it("commits one causal system entry per successful reload with monotonic revisions", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "v1" })] } },
        })

        await runtime.update({ config: { providers: [Mock({ hello: "v2" })] } })
        await runtime.update({ config: { providers: [Mock({ hello: "v3" })] } })

        const revisions = runtime.session.entries
            .filter(e => e.type === "axon:system:message" && e.data.type === "hot-reload")
            .map(e => e.data.attributes?.revision)

        expect(revisions).toEqual(["1", "2"])

        await runtime.shutdown()
    })

    it("a failing update() records axon:reload:failed and rethrows", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "v1" })] } },
        })

        const broken: CognetDefinition = {
            name: "broken",
            version: "1.0.0",
            abi: KERNEL_ABI_VERSION,
            load() { throw new Error("cognet reload exploded") },
            async wake() { },
        }

        let error: Error | undefined
        try {
            await runtime.update({ cognet: { name: "broken", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: broken } })
        } catch (err) {
            error = err as Error
        }

        expect(error?.message).toContain("cognet reload exploded")

        const failed = runtime.session.log.find(e => e.type === "axon:reload:failed")
        expect(failed).toBeDefined()
        expect((failed!.data as { error: { message: string } }).error.message).toContain("cognet reload exploded")

        expect(runtime.session.entries.some(e => e.type === "axon:system:message" && e.data.type === "hot-reload")).toBe(false)

        await runtime.shutdown()
    })
})

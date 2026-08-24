import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

/**
 * Bus handler failures are non-fatal but never silent. Plugins and modules
 * register handlers, so a silently-broken one is invisible rot — the failure
 * is constructed through err(), which delivers it to the session's error
 * sink and makes it durable. Before this, a throwing handler reached only
 * stderr and the in-memory history ring, so nothing survived the process.
 */
describe("Bus handler failures", () => {
    it("records a throwing handler in the durable session log", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "hi" }) } } })
        runtime.bus.on("kernel:run:start" as never, () => {
            throw new Error("plugin exploded")
        })

        await runtime.kernel.request({ content: "hello" })

        const errors = runtime.session.log.filter(e => e.type === "axon:error")
        const handlerFailure = errors.find(e => (e.data as { error: { code: string } }).error.code === "AX-RUNTIME-004")

        expect(handlerFailure).toBeDefined()

        await runtime.shutdown()
    })

    it("keeps running the remaining handlers after one throws", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "hi" }) } } })
        const reached: string[] = []

        runtime.bus.on("kernel:run:start" as never, () => {
            reached.push("first")
            throw new Error("boom")
        })
        runtime.bus.on("kernel:run:start" as never, () => {
            reached.push("second")
        })

        await runtime.kernel.request({ content: "hello" })

        // the throw is contained: a broken subscriber never starves its peers
        expect(reached).toEqual(["first", "second"])

        await runtime.shutdown()
    })

    it("does not let a failing axon:bus:error handler recurse", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "hi" }) } } })
        let calls = 0

        runtime.bus.on("kernel:run:start" as never, () => {
            throw new Error("original")
        })
        runtime.bus.on("axon:bus:error", () => {
            calls += 1
            throw new Error("the reporter is broken too")
        })

        await runtime.kernel.request({ content: "hello" })

        // reported once, and its own failure did not re-enter the path
        expect(calls).toBe(1)

        await runtime.shutdown()
    })
})

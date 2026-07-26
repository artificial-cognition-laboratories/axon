import { Axon } from "../../../setup/axon"

describe("server plugins: lifecycle hooks", () => {
    it("awaits boot:after handlers registered by a plugin before Axon() resolves", async () => {
        let ran = false

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "register-boot-hook", fn: () => {
                            globalThis.axon.hooks.hook("boot:after", async () => {
                                await new Promise(resolve => setTimeout(resolve, 5))
                                ran = true
                            })
                        } },
                    ],
                },
            },
        })

        expect(ran).toBe(true)

        await runtime.shutdown()
    })

    it("fires request:before ahead of the route handler", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "watch-requests", fn: () => {
                            globalThis.axon.hooks.hook("request:before", () => { calls.push("request:before") })
                        } },
                    ],
                    routes: [
                        { method: "GET", path: "/ping", handler: () => { calls.push("route"); return { ok: true } } },
                    ],
                },
            },
        })

        await runtime.server.handler(new Request("http://local/ping"))

        expect(calls).toEqual(["request:before", "route"])

        await runtime.shutdown()
    })

    it("fires request:after once the route handler has resolved", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "watch-requests", fn: () => {
                            globalThis.axon.hooks.hook("request:after", () => { calls.push("request:after") })
                        } },
                    ],
                    routes: [
                        { method: "GET", path: "/ping", handler: () => { calls.push("route"); return { ok: true } } },
                    ],
                },
            },
        })

        await runtime.server.handler(new Request("http://local/ping"))

        expect(calls).toEqual(["route", "request:after"])

        await runtime.shutdown()
    })

    it("fires request:before and request:after around user middleware and the route handler, in order", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "watch-requests", fn: () => {
                            globalThis.axon.hooks.hook("request:before", () => { calls.push("hook:before") })
                            globalThis.axon.hooks.hook("request:after", () => { calls.push("hook:after") })
                        } },
                    ],
                    middleware: [
                        { name: "mw", handler: () => { calls.push("middleware") } },
                    ],
                    routes: [
                        { method: "GET", path: "/ping", handler: () => { calls.push("route"); return { ok: true } } },
                    ],
                },
            },
        })

        await runtime.server.handler(new Request("http://local/ping"))

        expect(calls).toEqual(["hook:before", "middleware", "route", "hook:after"])

        await runtime.shutdown()
    })

    it("fires shutdown:before while the kernel is still alive", async () => {
        let kernelAliveDuringHook = false

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "watch-shutdown", fn: () => {
                            globalThis.axon.hooks.hook("shutdown:before", () => {
                                kernelAliveDuringHook = runtime.session.log.length > 0
                            })
                        } },
                    ],
                },
            },
        })

        await runtime.shutdown()

        expect(kernelAliveDuringHook).toBe(true)
    })
})

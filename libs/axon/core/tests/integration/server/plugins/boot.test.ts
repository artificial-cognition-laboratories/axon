import { Axon } from "../../../setup/axon"

describe("server plugins: boot", () => {
    it("runs a plugin during boot", async () => {
        let ran = false

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "mark", fn: () => { ran = true } },
                    ],
                },
            },
        })

        expect(ran).toBe(true)

        await runtime.shutdown()
    })

    it("runs plugins in declared order", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "first", fn: () => { calls.push("first") } },
                        { name: "second", fn: () => { calls.push("second") } },
                    ],
                },
            },
        })

        expect(calls).toEqual(["first", "second"])

        await runtime.shutdown()
    })

    it("awaits async plugins before routes are mounted", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "slow", fn: async () => {
                            await new Promise(resolve => setTimeout(resolve, 10))
                            calls.push("plugin")
                        } },
                    ],
                    routes: [
                        { method: "GET", path: "/ping", handler: () => { calls.push("route"); return { ok: true } } },
                    ],
                },
            },
        })

        await runtime.server.handler(new Request("http://local/ping"))

        expect(calls).toEqual(["plugin", "route"])

        await runtime.shutdown()
    })

    it("runs plugins before routes are mounted, even if a route never fires", async () => {
        let ran = false

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "mark", fn: () => { ran = true } },
                    ],
                    routes: [],
                },
            },
        })

        expect(ran).toBe(true)

        await runtime.shutdown()
    })

    it("aborts boot when a plugin throws", async () => {
        await expect(
            Axon({
                blueprint: {
                    server: {
                        plugins: [
                            { name: "broken", fn: () => { throw new Error("boom") } },
                        ],
                    },
                },
            }),
        ).rejects.toThrow(/broken/)
    })

    it("does not run later plugins after an earlier one throws", async () => {
        let laterRan = false

        await expect(
            Axon({
                blueprint: {
                    server: {
                        plugins: [
                            { name: "broken", fn: () => { throw new Error("boom") } },
                            { name: "later", fn: () => { laterRan = true } },
                        ],
                    },
                },
            }),
        ).rejects.toThrow()

        expect(laterRan).toBe(false)
    })

    it("tears down the already-booted kernel (capsule + session) when a plugin fails, leaking nothing into the next boot", async () => {
        const failing = () => Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "broken", fn: () => { throw new Error("boom") } },
                    ],
                },
            },
        })

        // if the first failed boot leaked its capsule subprocess or held the
        // session open, a second boot right after would hang or conflict
        await expect(failing()).rejects.toThrow(/broken/)
        await expect(failing()).rejects.toThrow(/broken/)
    })
})

import { Axon } from "../../setup/axon"

/**
 * Server plugins — behaviour-driven. A plugin in the blueprint runs once at
 * boot, receives THIS runtime's axon handle (not a global), and can register
 * a hook that later fires. Verified through observables (a hook the plugin
 * registers, the handle it receives) — never executor internals.
 */
describe("Server plugins", () => {
    it("runs a plugin at boot and passes it the runtime's axon handle", async () => {
        let received: unknown = null
        const runtime = await Axon({
            blueprint: {
                server: {
                    routes: [],
                    middleware: [],
                    plugins: [{ name: "spy", fn: (axon) => { received = axon } }],
                },
            },
        })

        // The plugin got the SAME handle the runtime exposes — bound to this
        // instance, not a global.
        expect(received).toBe(runtime.axon)

        await runtime.shutdown()
    })

    it("runs multiple plugins in blueprint order", async () => {
        const order: string[] = []
        const runtime = await Axon({
            blueprint: {
                server: {
                    routes: [],
                    middleware: [],
                    plugins: [
                        { name: "first", fn: () => { order.push("first") } },
                        { name: "second", fn: () => { order.push("second") } },
                    ],
                },
            },
        })

        expect(order).toEqual(["first", "second"])

        await runtime.shutdown()
    })

    it("a throwing plugin aborts boot", async () => {
        await expect(Axon({
            blueprint: {
                server: {
                    routes: [],
                    middleware: [],
                    plugins: [{ name: "boom", fn: () => { throw new Error("plugin exploded") } }],
                },
            },
        })).rejects.toThrow()
    })
})

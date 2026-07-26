import { Axon } from "../../setup/axon"
import type { AxonTool } from "@arcforge/types"

const greeterTool: AxonTool = {
    name: "greeter",
    origin: "src",
    flat: true,
    fns: [{ name: "greet", declaration: "function greet(name: string): string" }],
    source: `
        export default {
            name: "greeter",
            exports: {
                greet: (name) => "hello " + name,
            },
        }
    `,
}

describe("axon.tools", () => {
    it("calls the real tool function in the capsule and returns its result", async () => {
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: { policy: { tools: { greeter: true } } },
            },
        })

        const result = await runtime.axon.tools.greeter.greet("world")

        expect(result).toBe("hello world")

        await runtime.shutdown()
    })

    it("is denied by policy the same way a <typescript> block calling the same tool would be, when the blueprint explicitly denies it", async () => {
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: { policy: { tools: { greeter: false } } },
            },
        })

        await expect(runtime.axon.tools.greeter.greet("world")).rejects.toThrow(/CAPSULE_POLICY_DENIED/)

        await runtime.shutdown()
    })

    it("round-trips an argument value safely, even one shaped to look like code", async () => {
        const echoTool: AxonTool = {
            name: "echo",
            origin: "src",
            flat: true,
            fns: [{ name: "say", declaration: "function say(msg: string): string" }],
            source: `
                export default {
                    name: "echo",
                    exports: { say: (msg) => msg },
                }
            `,
        }

        const runtime = await Axon({
            blueprint: {
                tools: [echoTool],
                config: { policy: { tools: { echo: true } } },
            },
        })

        const tricky = `"); process.exit(1); ("`
        const result = await runtime.axon.tools.echo.say(tricky)

        expect(result).toBe(tricky)

        await runtime.shutdown()
    })

    it("passes multiple arguments through in order", async () => {
        const mathTool: AxonTool = {
            name: "math",
            origin: "src",
            flat: true,
            fns: [{ name: "add", declaration: "function add(a: number, b: number): number" }],
            source: `
                export default {
                    name: "math",
                    exports: { add: (a, b) => a + b },
                }
            `,
        }

        const runtime = await Axon({
            blueprint: {
                tools: [mathTool],
                config: { policy: { tools: { math: true } } },
            },
        })

        const result = await runtime.axon.tools.math.add(2, 3)

        expect(result).toBe(5)

        await runtime.shutdown()
    })

    it("only exposes namespaces/functions declared in blueprint.tools", async () => {
        const runtime = await Axon({
            blueprint: { tools: [greeterTool] },
        })

        expect(runtime.axon.tools.greeter).toBeDefined()
        expect(runtime.axon.tools.nonexistent).toBeUndefined()

        await runtime.shutdown()
    })

    it("a declared function whose namespace was never actually loaded fails loudly, not silently", async () => {
        const runtime = await Axon({
            blueprint: {
                // declared in fns metadata, but no `source` — never loaded into the capsule
                tools: [{ name: "ghost", origin: "package", flat: true, fns: [{ name: "vanish", declaration: "function vanish(): void" }] }],
                config: { policy: { tools: { ghost: true } } },
            },
        })

        await expect(runtime.axon.tools.ghost.vanish()).rejects.toThrow(/not defined/)

        await runtime.shutdown()
    })
})

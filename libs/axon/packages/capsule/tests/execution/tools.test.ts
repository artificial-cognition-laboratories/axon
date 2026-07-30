import { Capsule } from "@axon/capsule"
import { join } from "path"

const FIXTURES = join(import.meta.dir, "fixtures")
const MEMBERS: Record<string, string[]> = { math: ["add"], greet: ["hello"], counter: ["increment", "get"] }
const scope = (name: string) => ({
    name,
    members: MEMBERS[name]!.map(member => ({ name: member, declaration: `function ${member}(): unknown` })),
})

describe("Capsule tools", () => {
    it("reports capsule builtins and configured tools as one authoritative scope", () => {
        const capsule = Capsule({
            tools: [{ namespace: "math", scope: scope("math"), path: join(FIXTURES, "math.ts") }],
        })

        expect(capsule.scope.modules.map(module => module.name)).toEqual(["capsule", "math"])
        expect(capsule.scope.modules[0]?.members.map(member => member.name)).toEqual(["process", "signal"])
    })

    it("loads a tool from a path and makes it callable under its namespace", async () => {
        const capsule = Capsule({
            tools: [{ namespace: "math", scope: scope("math"), path: join(FIXTURES, "math.ts") }],
            policy: { tools: { math: true } },
        })
        await capsule.boot()

        const result = await capsule.run("math.add(1, 2)")
        expect(result).toBe(3)

        await capsule.shutdown()
    })

    it("loads a tool from inline source", async () => {
        const source = `
            export default {
                name: "greet",
                exports: {
                    hello: (name) => "hello " + name,
                },
            }
        `
        const capsule = Capsule({
            tools: [{ namespace: "greet", scope: scope("greet"), source }],
            policy: { tools: { greet: true } },
        })
        await capsule.boot()

        const result = await capsule.run(`greet.hello("world")`)
        expect(result).toBe("hello world")

        await capsule.shutdown()
    })

    it("loads multiple tools, each under its own namespace", async () => {
        const capsule = Capsule({
            tools: [
                { namespace: "math", scope: scope("math"), path: join(FIXTURES, "math.ts") },
                { namespace: "counter", scope: scope("counter"), path: join(FIXTURES, "counter.ts") },
            ],
            policy: { tools: { math: true, counter: true } },
        })
        await capsule.boot()

        const result = await capsule.run(`(await math.add(1, 1)) + (await counter.increment())`)
        expect(result).toBe(3)

        await capsule.shutdown()
    })

    it("installs flat scope members as top-level globals", async () => {
        const math = scope("math")
        const capsule = Capsule({
            tools: [{ namespace: "math", scope: { ...math, flat: true }, path: join(FIXTURES, "math.ts") }],
            policy: { tools: { math: true } },
        })
        await capsule.boot()

        expect(await capsule.run("add(2, 3)")).toBe(5)

        await capsule.shutdown()
    })

    it("loads raw TypeScript named exports for a flat source tool", async () => {
        const source = `
            export const test = { async test(): Promise<string> { return "test-ok" } }
            export const fs = { async test(): Promise<string> { return "fs-ok" } }
        `
        const capsule = Capsule({
            tools: [{
                namespace: "test",
                source,
                scope: {
                    name: "test",
                    flat: true,
                    members: [
                        { name: "test", declaration: "const test: { test(): Promise<string> }" },
                        { name: "fs", declaration: "const fs: { test(): Promise<string> }" },
                    ],
                },
            }],
            policy: { tools: { test: true } },
        })
        await capsule.boot()

        expect(await capsule.run("test.test()")).toBe("test-ok")
        expect(await capsule.run("fs.test()")).toBe("fs-ok")

        await capsule.shutdown()
    })

    it("rejects a tool whose declarations do not match its real exports", async () => {
        const capsule = Capsule({
            tools: [{
                namespace: "math",
                scope: { name: "math", members: [{ name: "subtract", declaration: "function subtract(): number" }] },
                path: join(FIXTURES, "math.ts"),
            }],
        })

        let caught: unknown
        try {
            await capsule.boot()
        } catch (e) {
            caught = e
        }
        expect((caught as { code?: string }).code).toBe("AX-CAPSULE-002")
    })

    it("persists tool-internal state across separate run() calls", async () => {
        const capsule = Capsule({
            tools: [{ namespace: "counter", scope: scope("counter"), path: join(FIXTURES, "counter.ts") }],
            policy: { tools: { counter: true } },
        })
        await capsule.boot()

        const first = await capsule.run("counter.increment()")
        const second = await capsule.run("counter.increment()")
        const third = await capsule.run("counter.get()")

        expect(first).toBe(1)
        expect(second).toBe(2)
        expect(third).toBe(2)

        await capsule.shutdown()
    })

    it("denies a tool call when the namespace has no policy rule", async () => {
        const capsule = Capsule({
            tools: [{ namespace: "math", scope: scope("math"), path: join(FIXTURES, "math.ts") }],
            policy: {}, // no tools.math entry — default deny
        })
        await capsule.boot()

        await expect(capsule.run("math.add(1, 2)")).rejects.toThrow("denied by policy")

        await capsule.shutdown()
    })

    it("does not expose a tool that was never loaded", async () => {
        const capsule = Capsule({
            tools: [],
            policy: {},
        })
        await capsule.boot()

        await expect(capsule.run("math.add(1, 2)")).rejects.toThrow()

        await capsule.shutdown()
    })
})

import { Capsule } from "@arcforge/capsule"

const MATH_SOURCE = `export default { exports: { add: (a, b) => a + b } }`
const GREET_SOURCE = `export default { exports: { hello: (name) => "hello " + name } }`
const MEMBERS: Record<string, string[]> = { math: ["add"], greet: ["hello"] }
const scope = (name: string) => ({
    name,
    members: MEMBERS[name]!.map(member => ({ name: member, declaration: `function ${member}(): unknown` })),
})

const bothTools = [
    { namespace: "math", scope: scope("math"), source: MATH_SOURCE },
    { namespace: "greet", scope: scope("greet"), source: GREET_SOURCE },
]

/**
 * `tools: <rule>` — one rule covering every tool, including ones installed
 * later.
 *
 * Enumerating namespaces was the only way to say this, and that list is
 * complete the day it is written and silently stale the moment anything else
 * is installed. Tested end-to-end through a real capsule rather than against
 * the normaliser, because what matters is that the MEDIATOR honours it.
 */
describe("Capsule policy — a blanket tools rule", () => {
    it("allows every namespace, named or not", async () => {
        const capsule = Capsule({ tools: bothTools, policy: { tools: true } })
        await capsule.boot()

        expect(await capsule.run("add(1, 2)")).toBe(3)
        expect(await capsule.run(`hello("world")`)).toBe("hello world")

        await capsule.shutdown()
    })

    it("denies every namespace, named or not", async () => {
        const capsule = Capsule({ tools: bothTools, policy: { tools: false } })
        await capsule.boot()

        await expect(capsule.run("add(1, 2)")).rejects.toThrow()
        await expect(capsule.run(`hello("world")`)).rejects.toThrow()

        await capsule.shutdown()
    })

    it("a named key beats the wildcard beside it", async () => {
        // Ordinary glob precedence, within one layer: the specific statement
        // is the more deliberate one.
        const capsule = Capsule({
            tools: bothTools,
            policy: { tools: { "*": false, math: true } },
        })
        await capsule.boot()

        expect(await capsule.run("add(1, 2)")).toBe(3)
        await expect(capsule.run(`hello("world")`)).rejects.toThrow()

        await capsule.shutdown()
    })

    it("covers a namespace the policy has never heard of", async () => {
        // The whole point: a tool installed after the policy was written is
        // still covered, because the rule names the surface not its contents.
        const capsule = Capsule({ tools: bothTools, policy: { tools: { "*": true } } })
        await capsule.boot()

        expect(await capsule.run(`hello("later")`)).toBe("hello later")

        await capsule.shutdown()
    })
})

/**
 * The policy map mirrors the agent's global scope one-for-one: a rule and a
 * call site are the same address. These pin the resolution walk — most
 * specific first — and the independence that makes the map an exact mirror.
 */
describe("Capsule policy — addresses mirror the scope", () => {
    it("a per-member rule inside a bag beats the bag's siblings", async () => {
        const source = `
            export default {
                name: "fs",
                exports: {
                    read: async () => "read-ok",
                    remove: async () => "removed",
                },
            }
        `
        const capsule = Capsule({
            tools: [{
                namespace: "fs",
                source,
                scope: {
                    name: "fs",
                    members: [
                        { name: "read", declaration: "function read(): Promise<string>" },
                        { name: "remove", declaration: "function remove(): Promise<string>" },
                    ],
                },
            }],
            policy: { tools: { fs: { read: true, remove: false } } },
        })
        await capsule.boot()

        expect(await capsule.run("read()")).toBe("read-ok")
        await expect(capsule.run("remove()")).rejects.toThrow("denied by policy")

        await capsule.shutdown()
    })

    it("a bag denies everything under it when written as a bare verdict", async () => {
        const source = `
            export default { name: "fs", exports: { read: async () => "read-ok" } }
        `
        const capsule = Capsule({
            tools: [{
                namespace: "fs",
                source,
                scope: { name: "fs", members: [{ name: "read", declaration: "function read(): Promise<string>" }] },
            }],
            // `fs: false` is the whole bag — no per-member rule needed.
            policy: { tools: { fs: false } },
        })
        await capsule.boot()

        await expect(capsule.run("read()")).rejects.toThrow("denied by policy")

        await capsule.shutdown()
    })
})

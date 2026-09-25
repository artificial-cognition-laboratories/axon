import { Capsule } from "@arcforge/capsule"

const MATH_SOURCE = `export default { exports: { add: (a, b) => a + b } }`
const GREET_SOURCE = `export default { exports: { hello: (name) => "hello " + name } }`
const MEMBERS: Record<string, string[]> = { math: ["add"], greet: ["hello"] }
const scope = (name: string) => ({
    name,
    members: MEMBERS[name]!.map(member => ({ name: member, declaration: `function ${member}(): unknown` })),
})

describe("Capsule policy — tools namespace resolution", () => {
    it("true allows every function in the namespace", async () => {
        const capsule = Capsule({
            tools: [{ namespace: "math", scope: scope("math"), source: MATH_SOURCE }],
            policy: { tools: { math: true } },
        })
        await capsule.boot()

        const result = await capsule.run("add(1, 2)")
        expect(result).toBe(3)

        await capsule.shutdown()
    })

    it("false denies every function in the namespace", async () => {
        const capsule = Capsule({
            tools: [{ namespace: "math", scope: scope("math"), source: MATH_SOURCE }],
            policy: { tools: { math: false } },
        })
        await capsule.boot()

        await expect(capsule.run("add(1, 2)")).rejects.toThrow("denied by policy")

        await capsule.shutdown()
    })

    it("a rule on one namespace does not leak to another", async () => {
        const capsule = Capsule({
            tools: [
                { namespace: "math", scope: scope("math"), source: MATH_SOURCE },
                { namespace: "greet", scope: scope("greet"), source: GREET_SOURCE },
            ],
            policy: { tools: { math: true } }, // greet has no entry
        })
        await capsule.boot()

        const mathResult = await capsule.run("add(1, 2)")
        expect(mathResult).toBe(3)

        await expect(capsule.run(`hello("world")`)).rejects.toThrow("denied by policy")

        await capsule.shutdown()
    })

    it("allow/deny globs evaluate against the call's first argument", async () => {
        const capsule = Capsule({
            tools: [{ namespace: "greet", scope: scope("greet"), source: GREET_SOURCE }],
            policy: { tools: { greet: { allow: ["world"], deny: ["admin"] } } },
        })
        await capsule.boot()

        const allowed = await capsule.run(`await hello("world")`)
        expect(allowed).toBe("hello world")

        await expect(capsule.run(`await hello("admin")`)).rejects.toThrow("denied by policy")

        await capsule.shutdown()
    })

    it("multiple namespaces with different rules are each enforced independently", async () => {
        const capsule = Capsule({
            tools: [
                { namespace: "math", scope: scope("math"), source: MATH_SOURCE },
                { namespace: "greet", scope: scope("greet"), source: GREET_SOURCE },
            ],
            policy: { tools: { math: true, greet: false } },
        })
        await capsule.boot()

        const mathResult = await capsule.run("add(2, 2)")
        expect(mathResult).toBe(4)

        await expect(capsule.run(`hello("world")`)).rejects.toThrow("denied by policy")

        await capsule.shutdown()
    })
})

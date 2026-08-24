import { Capsule } from "@axon/capsule"

/**
 * Scope extraction — the bindings a submission leaves behind.
 *
 * Tested against a real booted capsule through the public exec() surface:
 * what goes in is code, what comes out is the scope a template would
 * interpolate against. Nothing here reaches into the runner or the
 * globalThis diff that implements it.
 */
describe("Capsule scope: extraction", () => {
    it("returns the top-level bindings a block declared", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(`const d = 4\nconst obj = { a: 1, b: d }`)

        expect(scope.values.d).toBe(4)
        expect(scope.values.obj).toEqual({ a: 1, b: 4 })

        await capsule.shutdown()
    })

    it("captures const, let and var alike", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(`const a = 1\nlet b = 2\nvar c = 3`)

        expect(scope.values).toMatchObject({ a: 1, b: 2, c: 3 })

        await capsule.shutdown()
    })

    it("captures values produced by awaited work", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(`const n = await Promise.resolve(42)`)

        expect(scope.values.n).toBe(42)

        await capsule.shutdown()
    })

    it("returns an empty scope for a block that declares nothing", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(`1 + 1`)

        expect(scope.values).toEqual({})
        expect(scope.unavailable).toEqual([])

        await capsule.shutdown()
    })

    it("still returns the completion value alongside the scope", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { value, scope } = await capsule.exec(`const x = 7\nx * 2`)

        expect(value).toBe(14)
        expect(scope.values.x).toBe(7)

        await capsule.shutdown()
    })

    it("captures a deeply nested object whole", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(
            `const result = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, meta: { double: i * 2 } })) }`
        )

        const result = scope.values.result as { items: Array<{ id: number; meta: { double: number } }> }
        expect(result.items).toHaveLength(200)
        expect(result.items[199]?.meta.double).toBe(398)

        await capsule.shutdown()
    })
})

describe("Capsule scope: per-submission isolation", () => {
    it("returns only the bindings of the submission that declared them", async () => {
        const capsule = Capsule()
        await capsule.boot()

        await capsule.exec(`const first = 1`)
        const { scope } = await capsule.exec(`const second = 2`)

        // A template interpolates values from ITS OWN script, never one
        // three blocks ago.
        expect(scope.values).toEqual({ second: 2 })

        await capsule.shutdown()
    })

    it("does not leak tool namespaces into the scope", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(`const mine = 1`)

        expect(Object.keys(scope.values)).toEqual(["mine"])

        await capsule.shutdown()
    })

    it("reports a redeclared binding with its new value", async () => {
        const capsule = Capsule()
        await capsule.boot()

        await capsule.exec(`const v = 1`)
        const { scope } = await capsule.exec(`const v = 99`)

        expect(scope.values.v).toBe(99)

        await capsule.shutdown()
    })
})

describe("Capsule scope: what cannot cross", () => {
    it("reports a function by name rather than dropping it silently", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(`const fn = () => 1\nconst ok = 2`)

        expect(scope.values).toEqual({ ok: 2 })
        expect(scope.unavailable).toContainEqual({ name: "fn", reason: "function" })

        await capsule.shutdown()
    })

    it("reports a declared function statement too", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(`function helper() { return 1 }`)

        expect(scope.unavailable).toContainEqual({ name: "helper", reason: "function" })

        await capsule.shutdown()
    })

    it("reports a circular structure as circular", async () => {
        const capsule = Capsule()
        await capsule.boot()

        // Trailing `undefined` keeps the cycle out of the completion value,
        // which the wire cannot carry either. The binding is what matters.
        const { scope } = await capsule.exec(`const circ: any = {}\ncirc.self = circ\nundefined`)

        expect(scope.unavailable).toContainEqual({ name: "circ", reason: "circular" })
        expect(scope.values.circ).toBeUndefined()

        await capsule.shutdown()
    })

    it("does not let one unserializable binding lose the whole scope", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(
            `const good = { a: 1 }\nconst bad: any = {}\nbad.self = bad\nconst alsoGood = "yes"`
        )

        expect(scope.values.good).toEqual({ a: 1 })
        expect(scope.values.alsoGood).toBe("yes")
        expect(scope.unavailable).toContainEqual({ name: "bad", reason: "circular" })

        await capsule.shutdown()
    })

    it("reports a bigint binding as unserializable", async () => {
        const capsule = Capsule()
        await capsule.boot()

        // Trailing `undefined` keeps the bigint out of the COMPLETION value,
        // which the wire has never been able to carry (a bare `10n` as the
        // final expression fails the run itself — pre-existing, unrelated to
        // scope). What is under test is the binding.
        const { scope } = await capsule.exec(`const big = 10n\nundefined`)

        expect(scope.unavailable).toContainEqual({ name: "big", reason: "unserializable" })
        expect(scope.values.big).toBeUndefined()

        await capsule.shutdown()
    })
})

describe("Capsule scope: failure", () => {
    it("rejects rather than returning a scope when the block throws", async () => {
        const capsule = Capsule()
        await capsule.boot()

        expect(capsule.exec(`const a = 1\nthrow new Error("boom")`)).rejects.toThrow(/boom/)

        await capsule.shutdown()
    })
})

describe("Capsule scope: the size budget", () => {
    it("carries a large binding — interpolating a big value is the point", async () => {
        const capsule = Capsule()
        await capsule.boot()

        // A whole file's contents is exactly what this format exists to
        // avoid retyping, so the budget must clear it comfortably.
        const { scope } = await capsule.exec(`const doc = "x".repeat(200_000)\nundefined`)

        expect((scope.values.doc as string).length).toBe(200_000)
        expect(scope.unavailable).toEqual([])

        await capsule.shutdown()
    })

    it("reports a runaway binding as oversized rather than putting it on the wire", async () => {
        const capsule = Capsule()
        await capsule.boot()

        // The failure mode this guards: a script accumulating a repository
        // into one array, which would otherwise cross the process boundary
        // in full whether or not the template names it.
        const { scope } = await capsule.exec(`const huge = "y".repeat(3_000_000)\nundefined`)

        expect(scope.values.huge).toBeUndefined()
        expect(scope.unavailable).toContainEqual({ name: "huge", reason: "oversized" })

        await capsule.shutdown()
    })

    it("keeps the bindings that fit when a later one does not", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const { scope } = await capsule.exec(
            `const small = "kept"\nconst huge = "y".repeat(3_000_000)\nundefined`
        )

        expect(scope.values.small).toBe("kept")
        expect(scope.unavailable).toContainEqual({ name: "huge", reason: "oversized" })

        await capsule.shutdown()
    })
})

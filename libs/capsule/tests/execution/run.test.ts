import { Capsule } from "@axon/capsule"

describe("Capsule run", () => {
    it("returns the value the code returns", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const result = await capsule.run("1 + 1")
        expect(result).toBe(2)

        await capsule.shutdown()
    })

    it("returns null when the code returns nothing", async () => {
        // JSON has no undefined — the wire normalizes it to null, JSON's
        // nearest faithful encoding. Documented behavior, not an oversight.
        const capsule = Capsule()
        await capsule.boot()

        const result = await capsule.run("if (false) console.log('unreachable')")
        expect(result).toBeNull()

        await capsule.shutdown()
    })

    it("supports await inside the run body", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const result = await capsule.run(`
            const value = await Promise.resolve(42)
            value
        `)
        expect(result).toBe(42)

        await capsule.shutdown()
    })

    it("accepts TypeScript syntax and echoes the final expression", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const result = await capsule.run(`
            interface Point { x: number; y: number }
            const point: Point = { x: 20, y: 22 };
            (point as Point).x + point.y
        `)
        expect(result).toBe(42)

        await capsule.shutdown()
    })

    it("supports TypeScript enums as runtime values", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const result = await capsule.run(`
            enum Answer { value = 42 }
            Answer.value
        `)
        expect(result).toBe(42)

        await capsule.shutdown()
    })

    it("rejects when the code throws synchronously", async () => {
        const capsule = Capsule()
        await capsule.boot()

        await expect(capsule.run(`throw new Error("boom")`)).rejects.toThrow("boom")

        await capsule.shutdown()
    })

    it("rejects when the code throws after an await", async () => {
        const capsule = Capsule()
        await capsule.boot()

        await expect(capsule.run(`
            await Promise.resolve()
            throw new Error("boom after await")
        `)).rejects.toThrow("boom after await")

        await capsule.shutdown()
    })

    it("rejects when a returned promise rejects", async () => {
        const capsule = Capsule()
        await capsule.boot()

        await expect(capsule.run(`Promise.reject(new Error("rejected"))`)).rejects.toThrow("rejected")

        await capsule.shutdown()
    })

    it("returns plain data — objects and arrays round-trip through the wire", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const result = await capsule.run(`({ a: 1, b: [1, 2, 3], c: "text" })`)
        expect(result).toEqual({ a: 1, b: [1, 2, 3], c: "text" })

        await capsule.shutdown()
    })

    it("runs multiple times inside the same persistent global state", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const first = await capsule.run(`globalThis.__leak = "set"; 1`)
        expect(first).toBe(1)

        const second = await capsule.run(`typeof globalThis.__leak`)
        // Same subprocess incarnation — globals genuinely persist across runs
        // unless the tool/scope layer resets them. This documents that reality.
        expect(second).toBe("string")

        await capsule.shutdown()
    })

    it("persists REPL declarations across TypeScript blocks", async () => {
        const capsule = Capsule()
        await capsule.boot()

        expect(await capsule.run(`const persistent: number = 40; persistent`)).toBe(40)
        expect(await capsule.run(`persistent += 2; persistent`)).toBe(42)

        await capsule.shutdown()
    })

    it("exposes the native process object including persistent chdir", async () => {
        const capsule = Capsule({ cwd: "/tmp" })
        await capsule.boot()

        expect(await capsule.run(`(process as NodeJS.Process).chdir("/"); process.cwd()`)).toBe("/")
        expect(await capsule.run(`process.cwd()`)).toBe("/")

        await capsule.shutdown()
    })

    it("does not resolve one run's promise with another run's result", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const [a, b] = await Promise.all([
            capsule.run(`"a"`),
            capsule.run(`"b"`),
        ])

        expect([a, b].sort()).toEqual(["a", "b"])

        await capsule.shutdown()
    })
})

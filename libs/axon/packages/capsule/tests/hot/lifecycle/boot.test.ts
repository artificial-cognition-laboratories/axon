import { Capsule } from "@arcforge/capsule"

describe("Capsule boot", () => {
    it("boots, reports ready, and can run code", async () => {
        const capsule = Capsule()

        await capsule.boot()

        const result = await capsule.run("1 + 1")
        expect(result).toBe(2)

        await capsule.shutdown()
    })
})

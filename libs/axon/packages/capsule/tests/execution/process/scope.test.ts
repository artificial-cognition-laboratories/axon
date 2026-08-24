import { Capsule } from "@axon/capsule"

describe("Capsule process global augmentation", () => {
    it("blocks process.exit() — the capsule manages its own subprocess lifecycle", async () => {
        const capsule = Capsule()
        await capsule.boot()

        await expect(capsule.run("process.exit(1)")).rejects.toThrow("CAPSULE_SCOPE_VIOLATION")

        await capsule.shutdown()
    })

    it("stays usable after a blocked process.exit() call", async () => {
        const capsule = Capsule()
        await capsule.boot()

        await expect(capsule.run("process.exit(1)")).rejects.toThrow()

        const result = await capsule.run("1 + 1")
        expect(result).toBe(2)

        await capsule.shutdown()
    })

    it("leaves untouched Node process members working — env, cwd, platform", async () => {
        const capsule = Capsule({ env: { CUSTOM_VAR: "value" } })
        await capsule.boot()

        const result = await capsule.run(`
            ({
                env: process.env.CUSTOM_VAR,
                hasCwd: typeof process.cwd() === "string",
                platform: typeof process.platform,
            })
        `)

        expect(result).toEqual({ env: "value", hasCwd: true, platform: "string" })

        await capsule.shutdown()
    })
})

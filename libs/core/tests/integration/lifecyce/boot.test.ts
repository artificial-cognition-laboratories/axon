import { Axon } from "../../setup/axon"

describe("Axon boot", () => {
    it("boots and shuts down cleanly with a minimal blueprint", async () => {
        const runtime = await Axon()

        expect(runtime.blueprint.agent.name).toBe("unnamed-agent")
        expect(runtime.server).toBeDefined()

        await runtime.shutdown()
    })
})

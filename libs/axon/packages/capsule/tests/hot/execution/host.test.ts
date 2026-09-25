import { Capsule } from "@arcforge/capsule"

describe("Capsule Axon host bridge", () => {
    it("forwards axon.request through the trusted host and returns its result", async () => {
        const calls: Array<{ method: string; input: unknown }> = []
        const capsule = Capsule({
            host: {
                async call({ method, input }) {
                    calls.push({ method, input })
                    return { text: "child reply", entries: [] }
                },
            },
        })
        await capsule.boot()

        const result = await capsule.run(`await axon.request("delegated task")`)

        expect(calls).toEqual([{ method: "request", input: { prompt: "delegated task" } }])
        expect(result).toEqual({ text: "child reply", entries: [] })
        await capsule.shutdown()
    })
})

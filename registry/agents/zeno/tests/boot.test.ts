describe("agent", () => {
    it("boots", async () => {
        const { axon, stop } = await Axon()
        expect(axon).toBeDefined()
        await stop()
    })
})

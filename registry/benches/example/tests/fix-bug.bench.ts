import { expect, it } from "bun:test"

it("resolves the failing parser test", async ({ workspace }) => {
    // expect = harness validity. If the world is wrong, this trial is not a
    // measurement of anything and must stop rather than score zero.
    expect(await workspace.exists("src/parser.ts")).toBe(true)

    const { axon } = await Axon()
    await axon.request("fix the parser")

    // observe = measurement. Recorded whatever happens — a model that fails
    // every trial is a finding, not a broken benchmark.
    observe("resolved", await workspace.tests.pass({ timeoutMs: 30_000 }))
    observe("collateral", (await workspace.changed()).filter(f => f !== "src/parser.ts").length)
})

import { Air } from "../../src"

/**
 * The turn-ending signal, in every form a model actually writes.
 *
 * Regression: the pattern was bare-only (`/<done\s*\/>/`), so
 * `<done from="agent"/>` produced NO done event. The turn did not end, the
 * loop woke the agent again, and it answered a second time — a duplicated
 * reply and a second billed generation. The protocol teaches bare `<done/>`,
 * but every other tag takes attributes (`<text from="agent" lang="md">`), so
 * the model drifts into writing them here too.
 */
describe("Air parser: done signal", () => {
    const feed = (input: string) => Air().parser().feed(input)

    it("ends the turn on a bare <done/>", () => {
        expect(feed("<text>hi</text><done/>")).toContainEqual({ type: "done" })
    })

    it("ends the turn on <done /> with inner whitespace", () => {
        expect(feed("<text>hi</text><done />")).toContainEqual({ type: "done" })
    })

    it("ends the turn on an attributed <done from=\"agent\"/>", () => {
        expect(feed("<text>hi</text><done from=\"agent\"/>")).toContainEqual({ type: "done" })
    })

    it("ends the turn on an attributed <done/> with trailing space", () => {
        expect(feed("<text>hi</text><done from=\"agent\" />")).toContainEqual({ type: "done" })
    })

    it("emits exactly one done for one signal", () => {
        const events = feed("<text>hi</text><done from=\"agent\"/>")
        expect(events.filter(e => e.type === "done")).toHaveLength(1)
    })

    it("does not treat a different tag as done", () => {
        expect(feed("<donenot/>").some(e => e.type === "done")).toBe(false)
    })
})

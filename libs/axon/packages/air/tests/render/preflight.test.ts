import type { AxonEntry, AxonEntryEvent } from "@arcforge/types"
import { Air } from "../../src"

let seq = 1
function entry<K extends keyof AxonEntryEvent>(type: K, data: AxonEntryEvent[K]): AxonEntry {
    return { id: `e${seq}`, type, time: { ms: seq, seq: seq++ }, data } as AxonEntry
}

const rendered = (history: AxonEntry[] = [entry("cognet:stimulus:text", { channel: "user", content: "do the thing" })]) =>
    Air().render({ history })

/**
 * The preflight exchange — a demonstration, not a description.
 *
 * Models opened runs with four and five `<script>` blocks at once, BEFORE any
 * history existed to shape them. A fenced example inside a system block is a
 * description of a format; what a model continues is a conversation, and on
 * turn one there was none to continue.
 */
describe("Air render: the preflight exchange", () => {
    it("puts a demonstration conversation ahead of the real one", () => {
        const turns = rendered().filter(m => m.role !== "system")
        // Demonstration first, the user's actual message last.
        expect(turns.at(-1)!.content).toContain("do the thing")
        expect(turns[0]!.content).toContain("systems check")
    })

    it("shows one script per message, and its result before the conclusion", () => {
        const turns = rendered().filter(m => m.role === "assistant")
        for (const turn of turns) {
            expect(turn.content.match(/<script\b/g)?.length ?? 0).toBeLessThanOrEqual(1)
        }
        // Every script's output comes back before the next turn — the whole
        // point of the rhythm being demonstrated.
        const all = rendered().map(m => m.content).join("\n")
        expect(all).toContain(`<stdout for="pe1"`)
        expect(all).toContain(`<stdout for="pe2"`)
    })

    it("still shows that independent work may be batched", () => {
        // The lesson is "one step per message", not "never do two things" — a
        // model correcting away from four scripts needs somewhere to put
        // legitimate parallel work.
        expect(rendered().map(m => m.content).join("\n")).toContain("Promise.all")
    })

    it("uses ids that cannot collide with the real timeline", () => {
        const all = rendered([
            entry("cognet:action:typescript", { id: "a1", content: "1+1" }),
            entry("cognet:action:result", { for: "a1", ok: true, content: "2" }),
        ]).map(m => m.content).join("\n")
        // The real timeline numbers from e1; the preflight uses p*. Two blocks
        // answering to one id is the ambiguity `for=` exists to remove.
        expect(all.match(/id="e1"/g)).toHaveLength(1)
    })

    it("calls no tools — an agent may have none of them installed", () => {
        const all = rendered().filter(m => m.role !== "system").map(m => m.content).join("\n")
        expect(all).not.toContain("fs.")
        expect(all).not.toContain("process.run")
    })

    it("renders nothing when there is no conversation to precede", () => {
        const turns = Air().render({}).filter(m => m.role !== "system")
        // Otherwise the preflight IS the conversation, and the model answers a
        // systems check nobody asked for.
        expect(turns).toHaveLength(0)
    })
})

/**
 * The format declares its own version, first.
 *
 * A model can then recognise the dialect rather than infer it from shape — and
 * the format becomes identifiable in whatever corpus these conversations reach,
 * which is the whole point of fixing a canonical one.
 */
describe("Air render: the format version", () => {
    it("leads the context", () => {
        const first = Air().render({ base: "x" })[0]!
        expect(first.role).toBe("system")
        expect(first.content).toContain(`type="air"`)
        expect(first.content).toMatch(/version="\d+\.\d+\.\d+"/)
    })

    it("is present even with no identity and no history", () => {
        // It describes the FORMAT, so it cannot depend on what the caller
        // happens to have supplied.
        expect(Air().render({})[0]!.content).toContain(`type="air"`)
    })

    it("is a system block, not a fourth top-level tag", () => {
        // One family for "the runtime is telling you something"; `type` carries
        // the rest. A bespoke tag would be one more thing to explain.
        expect(Air().render({})[0]!.content).toStartWith("<system")
    })
})

/**
 * The preflight demonstrates an INTERRUPT.
 *
 * A model that has never seen one reads it as a failure of its own and retries
 * the work it was just told to stop — the worst possible response. Shown rather
 * than described, for the same reason the rest of the exchange is.
 */
describe("Air render: the demonstrated interrupt", () => {
    /** The conversation only — the contract names these tags too. */
    const all = () => rendered().filter(m => m.role !== "system").map(m => m.content).join("\n")

    it("shows a run being cut short", () => {
        expect(all()).toContain(`<interrupt from="terminal" reason="user"/>`)
    })

    it("shows the agent stopping rather than retrying", () => {
        const text = all()
        expect(text).toContain("Stopped.")
        // The turn ends there — an interrupt is a settled outcome, not an error
        // to work around.
        expect(text.indexOf("Stopped.")).toBeLessThan(text.lastIndexOf("<done"))
    })

    it("puts the interrupt after work that succeeded", () => {
        // So it reads as an ordinary event in a working session rather than as
        // an error state the agent got itself into.
        const text = all()
        expect(text.indexOf(`for="pe1"`)).toBeLessThan(text.indexOf("<interrupt"))
    })
})

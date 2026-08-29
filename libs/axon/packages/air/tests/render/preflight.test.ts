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

    /**
     * The seam between demonstration and session.
     *
     * The preflight works BECAUSE its turns are indistinguishable from real
     * ones, so nothing marks them (see `Protocol["preflight"]`). That leaves
     * anything reading the context — the engine viewer above all — unable to
     * say where the agent's actual conversation begins. The marker separates
     * the two without labelling either.
     */
    describe("the session boundary", () => {
        it("marks where the demonstration ends and the session begins", () => {
            const messages = rendered()
            const at = messages.findIndex(m => m.content.includes(`type="session:start"`))
            expect(at).toBeGreaterThan(-1)

            // The marker OPENS the session's first turn — everything before
            // that message is the demonstration, and the user's actual words
            // are in the same message, directly beneath it.
            expect(messages[at]!.content).toContain("do the thing")
            expect(messages[at]!.content.indexOf("session:start"))
                .toBeLessThan(messages[at]!.content.indexOf("do the thing"))
            expect(messages.slice(0, at).map(m => m.content).join("\n")).toContain("systems check")
        })

        it("never sends two user turns in a row to say it", () => {
            // Its own message would sit immediately before the session's
            // opening user turn. Providers variously reject or silently merge
            // consecutive same-role messages, so the merge is done here and
            // the result is the same everywhere.
            const roles = rendered().map(m => m.role)
            for (let i = 1; i < roles.length; i++) {
                if (roles[i] === "system") continue
                expect(roles[i] === "user" && roles[i - 1] === "user").toBe(false)
            }
        })

        it("is absent when no demonstration precedes the session", () => {
            // Nothing to separate: a marker announcing the start of something
            // that started at the top of the document is noise.
            const messages = Air().render({
                preflight: false,
                history: [entry("cognet:stimulus:text", { channel: "user", content: "hi" })],
            })
            expect(messages.some(m => m.content.includes(`type="session:start"`))).toBe(false)
        })

        it("is absent when there is no session at all", () => {
            expect(Air().render({}).some(m => m.content.includes(`type="session:start"`))).toBe(false)
        })

        it("does not label the demonstration turns themselves", () => {
            // The marker is on the SEAM. A turn carrying an attribute saying
            // it is an example invites the model to discount it, which is the
            // one thing that would undo the preflight.
            const demo = rendered()
            const at = demo.findIndex(m => m.content.includes(`type="session:start"`))
            const turns = demo.slice(0, at).filter(m => m.role !== "system").map(m => m.content).join("\n")
            expect(turns).not.toContain("session:start")
            expect(turns).not.toContain("example")
            expect(turns).not.toContain("demonstration")
        })

        it("does not break the conversation into a system message mid-stream", () => {
            // Everything from the demonstration down is alternating
            // user/assistant turns. A system-role message spliced into that
            // breaks the shape the conversation rendering exists to produce.
            const messages = rendered()
            const at = messages.findIndex(m => m.content.includes(`type="session:start"`))
            expect(messages[at]!.role).toBe("user")
            expect(messages.slice(at).every(m => m.role !== "system")).toBe(true)
        })
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

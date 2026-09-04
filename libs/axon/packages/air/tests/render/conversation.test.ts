import type { AxonEntry, AxonEntryEvent } from "@arcforge/types"
import { Air } from "../../src"
import { describe, it, expect } from "bun:test"

function entry<K extends keyof AxonEntryEvent>(type: K, data: AxonEntryEvent[K], runId?: string): AxonEntry {
    return {
        id: `${type}-${Math.random()}`,
        type,
        time: { ms: Date.now(), seq: seq++ },
        ...(runId ? { context: { runId } } : {}),
        data,
    } as AxonEntry
}
let seq = 1

/**
 * The rendered conversation, with the preflight exchange dropped.
 *
 * Every render prepends a short demonstration exchange (see
 * `Protocol["preflight"]`) so the model has a rhythm to continue rather than
 * an empty history to invent one for. It is real messages by design, which
 * means every test counting turns has to exclude it — and it is identified by
 * its `p*` ids, which the real timeline never issues.
 */
function conversation(entries: AxonEntry[]) {
    return render({ history: entries }).filter(m => m.role !== "system")
}

/**
 * Render, then drop the preflight — what the tests below are about.
 *
 * Counted by LENGTH rather than matched by content: the preflight is a fixed
 * exchange rendered ahead of every conversation, and its own turns carry no
 * marker (deliberately — see `Protocol["preflight"]`). Its size is the honest
 * way to skip it, and it is asserted directly in its own test.
 */
/**
 * Render only the caller's own turns.
 *
 * No preflight passed, so none is rendered — omission is how a caller says
 * "just my conversation". The preflight has its own suite.
 */
function render(input: { history: AxonEntry[] }) {
    return Air().render(input)
}

const turns = (entries: AxonEntry[]) => conversation(entries)

/**
 * The history as a real conversation.
 *
 * A captured failing context showed the whole problem: everything arrived in
 * ONE `user` message as a `<timeline>` document, so the model never saw an
 * `assistant` turn in its own context — nothing demonstrated what its own
 * output looked like, and it emitted empty `<text>` blocks.
 */
describe("Air render: history is a conversation", () => {
    it("delivers the user's turn in a user message, still framed as a block", () => {
        const messages = render({
            history: [entry("cognet:stimulus:text", { channel: "user", content: "list the files" })],
        })
        const last = messages.at(-1)!
        // The ROLE is the fix — it used to arrive as one <timeline> document
        // in a user message, so the model never saw an assistant turn.
        expect(last.role).toBe("user")
        // The STRUCTURE stays. Bare prose at the end of a heavily structured
        // context is the one unframed thing in it.
        expect(last.content).toContain(`<text from="user" id="u1"`)
        expect(last.content).toContain("list the files")
        // But not wrapped in a document that claims to be the whole history.
        expect(last.content).not.toContain("<timeline>")
    })

    it("gives the model its own reply back as an assistant message", () => {
        const messages = render({
            history: [
                entry("cognet:stimulus:text", { channel: "user", content: "hi" }, "r1"),
                entry("cognet:output:text", { channel: "reply", content: "hello there" }, "r1"),
            ],
        })
        const assistant = messages.filter(m => m.role === "assistant")
        expect(assistant).toHaveLength(1)
        expect(assistant[0]!.content).toContain("hello there")
        expect(assistant[0]!.content).toContain("<text")
        // Top level, no <agent> wrapper: the assistant role already says the
        // model spoke, and the wrapper was a fourth tag the contract never
        // named — which the model imitated and was rejected for.
        expect(assistant[0]!.content).toStartWith("<text from=\"agent\"")
        expect(assistant[0]!.content).not.toContain("<agent>")
    })

    it("keeps a template and a script from one wake in ONE assistant turn", () => {
        const messages = render({
            history: [
                entry("cognet:stimulus:text", { channel: "user", content: "go" }, "r1"),
                entry("cognet:output:text", { channel: "reply", content: "checking" }, "r1"),
                entry("cognet:action:typescript", { id: "a1", content: 'await fs.list(".")' }, "r1"),
            ],
        })
        const assistant = messages.filter(m => m.role === "assistant")
        expect(assistant).toHaveLength(1)
        expect(assistant[0]!.content).toContain("<text")
        expect(assistant[0]!.content).toContain("<script")
    })

    it("separates turns from different wakes", () => {
        const messages = render({
            history: [
                entry("cognet:output:text", { channel: "reply", content: "first" }, "r1"),
                entry("cognet:output:text", { channel: "reply", content: "second" }, "r2"),
            ],
        })
        expect(messages.filter(m => m.role === "assistant")).toHaveLength(2)
    })

    it("returns a script's stdout as a user turn — the world answering", () => {
        const messages = render({
            history: [
                entry("cognet:action:typescript", { id: "a1", content: "1+1" }, "r1"),
                entry("cognet:action:result", { for: "a1", ok: true, content: "2" }, "r1"),
            ],
        })
        expect(messages.at(-1)!.role).toBe("user")
        expect(messages.at(-1)!.content).toContain("<stdout")
        // The id must match the one the assistant turn was given.
        expect(messages.find(m => m.role === "assistant")!.content).toContain('id="e1"')
        expect(messages.at(-1)!.content).toContain('for="e1"')
    })

    it("carries the channel on every user turn — it is the return address", () => {
        const fromTelegram = render({
            history: [entry("cognet:stimulus:text", { channel: "telegram:8199", content: "yo" })],
        }).at(-1)!
        expect(fromTelegram.content).toContain('channel="telegram:8199"')

        // Present on a terminal turn too, so the mind never has to infer a
        // default — the reason a channel module once smuggled it into content.
        const fromTerminal = render({
            history: [entry("cognet:stimulus:text", { channel: "user", content: "yo" })],
        }).at(-1)!
        expect(fromTerminal.content).toContain('channel="user"')
    })

    it("gives a rejected reply back as the model's own assistant turn", () => {
        const messages = render({
            history: [
                entry("axon:system:malformed", {
                    content: "<script>a</script><script>b</script>",
                    code: "OUTPUT_TOO_MANY_BLOCKS",
                    attempt: 1,
                }, "r1"),
                entry("axon:system:message", {
                    type: "format-violation", lang: "md", content: "## Too many blocks",
                }, "r1"),
            ],
        })
        // The model must read its own bad output as something IT said.
        const assistant = messages.find(m => m.role === "assistant")!
        expect(assistant.content).toContain(`<script status="rejected">a</script>`)
        // And the verdict as something the runtime said.
        expect(messages.at(-1)!.role).toBe("user")
        expect(messages.at(-1)!.content).toContain("Too many blocks")
    })

    it("never leaves the model without an assistant turn once it has spoken", () => {
        const messages = render({
            history: [
                entry("cognet:stimulus:text", { channel: "user", content: "a" }, "r1"),
                entry("cognet:output:text", { channel: "reply", content: "b" }, "r1"),
                entry("cognet:stimulus:text", { channel: "user", content: "c" }, "r2"),
            ],
        })
        expect(messages.some(m => m.role === "assistant")).toBe(true)
        // And the conversation alternates the way a conversation does.
        const roles = messages.filter(m => m.role !== "system").map(m => m.role)
        expect(roles).toEqual(["user", "assistant", "user"])
    })

    it("shows ONE rejected exchange, however many retries a wake burned", () => {
        const run = "r1"
        const messages = render({
            history: [
                entry("cognet:stimulus:text", { channel: "user", content: "go" }, run),
                entry("axon:system:malformed", { content: "BAD ONE", code: "OUTPUT_EMPTY", attempt: 1 }, run),
                entry("axon:system:message", { type: "format-violation", lang: "md", content: "CORRECTION ONE" }, run),
                entry("axon:system:malformed", { content: "BAD TWO", code: "OUTPUT_EMPTY", attempt: 2 }, run),
                entry("axon:system:message", { type: "format-violation", lang: "md", content: "CORRECTION TWO" }, run),
                entry("axon:system:malformed", { content: "BAD THREE", code: "OUTPUT_EMPTY", attempt: 3 }, run),
                entry("axon:system:message", { type: "format-violation", lang: "md", content: "CORRECTION THREE" }, run),
            ],
        })
        const all = messages.map(m => m.content).join("\n")

        // Retries share a runId by construction, so wake-scoping alone kept
        // every failure — three examples of malformed output in front of a
        // model being asked for well-formed output, which is the degradation
        // spiral itself.
        expect(all).toContain("BAD THREE")
        expect(all).toContain("CORRECTION THREE")
        expect(all).not.toContain("BAD ONE")
        expect(all).not.toContain("BAD TWO")
        expect(all).not.toContain("CORRECTION ONE")
        expect(all).not.toContain("CORRECTION TWO")
    })

    it("drops the exchange entirely once the model has moved past it", () => {
        const all = render({
            history: [
                entry("axon:system:malformed", { content: "BAD", code: "OUTPUT_EMPTY", attempt: 1 }, "r1"),
                entry("axon:system:message", { type: "format-violation", lang: "md", content: "CORRECTION" }, "r1"),
                entry("cognet:output:text", { channel: "reply", content: "recovered" }, "r1"),
                entry("cognet:stimulus:text", { channel: "user", content: "next" }, "r2"),
            ],
        }).map(m => m.content).join("\n")

        expect(all).toContain("next")
        expect(all).not.toContain("BAD")
        expect(all).not.toContain("CORRECTION")
    })

    it("shows the model its own turn ending, inside the turn it ended", () => {
        const messages = render({
            history: [
                entry("cognet:stimulus:text", { channel: "user", content: "hi" }, "r1"),
                entry("cognet:output:text", { channel: "reply", content: "found it" }, "r1"),
                entry("axon:agent:done", {}, "r1"),
            ],
        })
        const assistant = messages.filter(m => m.role === "assistant")

        // `<done/>` was parsed as a signal and dropped, making it the one block
        // the model read a rule about every call and never saw itself use.
        expect(assistant).toHaveLength(1)
        expect(assistant[0]!.content).toContain(`<done from="agent"/>`)
        // Inside the turn, not its own message — a `<done/>` alone would read
        // as a reply whose entire content was "I am finished".
        expect(assistant[0]!.content).toContain("found it")
    })

    it("still renders the document form when pinned to it", () => {
        process.env.AXON_AIR_TIMELINE = "document"
        try {
            const messages = render({
                history: [entry("cognet:stimulus:text", { channel: "user", content: "hi" })],
            })
            expect(messages.at(-1)!.content).toStartWith("<timeline>")
            expect(messages.some(m => m.role === "assistant")).toBe(false)
        } finally {
            delete process.env.AXON_AIR_TIMELINE
        }
    })
})

/**
 * Markdown bodies are never indented.
 *
 * The transcript is the strongest instruction a model gets — stronger than the
 * contract — so an indented example teaches it to indent its own replies. Four
 * leading spaces IS an indented code block in CommonMark, which turned a
 * 9,439-char answer into a single `code_block`: raw source, unwrapped and
 * clipped, instead of 68 paragraphs, 14 headings and 24 fences.
 */
describe("Air render: markdown is flush-left", () => {
    const entry = (type: string, data: unknown, seq: number): AxonEntry => ({
        id: `e${seq}`, type, time: { ms: seq, seq }, context: { runId: "r1" }, data,
    } as unknown as AxonEntry)

    it("never indents an agent's <text> body", () => {
        const messages = Air().render({
            history: [
                entry("cognet:stimulus:text", { channel: "terminal", content: "hi" }, 1),
                entry("cognet:output:text", { channel: "reply", content: "## Heading\n\nA paragraph." }, 2),
            ],
        })

        const spoken = messages.filter(m => String(m.content).includes("<text from=\"agent\""))
        expect(spoken.length).toBeGreaterThan(0)
        for (const message of spoken) {
            expect(String(message.content)).not.toMatch(/<text[^>]*>\n {4}\S/)
        }
    })

    it("never indents a user's <text> body", () => {
        const messages = Air().render({
            history: [entry("cognet:stimulus:text", { channel: "terminal", content: "- a list\n- of items" }, 1)],
        })

        for (const message of messages.filter(m => String(m.content).includes("<text from=\"user\""))) {
            expect(String(message.content)).not.toMatch(/<text[^>]*>\n {4}\S/)
        }
    })

    it("still indents a <script> body", () => {
        // Code is not markdown. Leading whitespace is content there, and the
        // indent keeps the block readable inside its turn.
        const messages = Air().render({
            history: [
                entry("cognet:stimulus:text", { channel: "terminal", content: "go" }, 1),
                entry("cognet:action:typescript", { id: "x1", content: "const a = 1" }, 2),
            ],
        })

        // Only the assistant turn: the contract system block mentions
        // `<script>` in its prose and would otherwise match first.
        const scripts = messages.filter(m => String(m.content).includes("<script from=\"agent\""))
        expect(scripts.length).toBeGreaterThan(0)
        expect(String(scripts[0]!.content)).toMatch(/<script[^>]*>\n {4}\S/)
    })
})

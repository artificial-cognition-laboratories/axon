import type { AxonEntry, AxonEntryEvent } from "@arcforge/types"
import { Air } from "../../src"
import { describe, it, expect } from "bun:test"

/**
 * Render with the history as ONE `<timeline>` document.
 *
 * The default is now a real conversation — user turns as `user` messages,
 * the agent's own replies as `assistant` messages — because the document
 * form never showed a model an assistant turn in its own context. These
 * suites assert the document renderer specifically, so they pin it; the
 * conversation shape has its own suite.
 */
function asDocument<T>(render: () => T): T {
    const previous = process.env.AXON_AIR_TIMELINE
    process.env.AXON_AIR_TIMELINE = "document"
    try {
        return render()
    } finally {
        if (previous === undefined) delete process.env.AXON_AIR_TIMELINE
        else process.env.AXON_AIR_TIMELINE = previous
    }
}


/**
 * Timeline rendering takes DOMAIN entries (AxonEntry[]) and owns the
 * translation internally. These tests feed real entries and assert the
 * rendered <timeline> — exercising the exhaustive switch that is the single
 * chokepoint between memory format (stimulus, output, action, system entries)
 * and wire format.
 */
describe("Air render: timeline", () => {
    function render(entries: AxonEntry[]): string {
        return asDocument(() => Air().render({ history: entries }))
            .find(m => m.content.startsWith("<timeline>"))?.content ?? ""
    }

    it("renders a cognet:stimulus:text as a user turn", () => {
        const content = render([entry("cognet:stimulus:text", { channel: "user", content: "hello" })])
        expect(content).toContain(`<text from="user" id="u1"`)
        expect(content).toContain("hello")
    })

    /**
     * The channel is the return address. Without it on the turn the mind can
     * hear a message and have no way to answer it — which is what forced
     * channel modules to smuggle their address into the content.
     */
    it("carries the stimulus channel onto the user turn", () => {
        const content = render([
            entry("cognet:stimulus:text", { channel: "telegram:123456789", content: "did the deploy finish?" }),
        ])
        expect(content).toContain(`channel="telegram:123456789"`)
        // Routing is metadata about the turn, never words inside it.
        expect(content).not.toContain("[telegram:123456789]")
    })

    it("labels a terminal turn rather than leaving it unattributed", () => {
        const content = render([entry("cognet:stimulus:text", { channel: "user", content: "hello" })])
        expect(content).toContain(`channel="user"`)
    })

    it("distinguishes two channels in one timeline", () => {
        const content = render([
            entry("cognet:stimulus:text", { channel: "user", content: "from the terminal" }),
            entry("cognet:stimulus:text", { channel: "telegram:42", content: "from telegram" }),
        ])
        expect(content).toContain(`channel="user"`)
        expect(content).toContain(`channel="telegram:42"`)
    })

    it("renders cognet:output:text as an agent text turn", () => {
        const content = render([entry("cognet:output:text", { channel: "reply", content: "hi there" })])
        expect(content).toContain("<agent>")
        expect(content).toContain("<text")
        expect(content).toContain("hi there")
    })

    it("renders cognet:action:typescript with a short sequential id, not the raw id", () => {
        const content = render([entry("cognet:action:typescript", { id: "raw-uuid-123", content: "1+1" })])
        expect(content).toContain(`<script from="agent" id="e1"`)
        expect(content).not.toContain("raw-uuid-123")
    })

    it("maps a result's `for` to the same short id as its execute block", () => {
        const content = render([
            entry("cognet:action:typescript", { id: "raw-uuid-123", content: "1+1" }),
            entry("cognet:action:result", { for: "raw-uuid-123", ok: true, content: "2" }),
        ])
        expect(content).toContain(`<script from="agent" id="e1"`)
        expect(content).toContain(`<stdout for="e1"`)
    })

    it("marks a failed result with ok=false and the error", () => {
        const content = render([
            entry("cognet:action:result", { for: "x", ok: false, content: "", error: { kind: "exception", message: "boom" } }),
        ])
        expect(content).toContain(`ok="false"`)
        expect(content).toContain("boom")
    })

    it("renders a durable generic system message with escaped attributes", () => {
        const content = render([
            entry("axon:system:message", {
                type: "hot-reload",
                lang: "txt",
                content: "context changed",
                attributes: { revision: "2", reason: `boot\"save` },
            }),
        ])

        expect(content).toContain(`<system type="hot-reload" lang="txt" reason="boot&quot;save" revision="2">`)
        expect(content).toContain("context changed")
    })

    it("renders axon:interrupt as its own top-level marker", () => {
        // Promoted out of `<system type="interrupt">` for the same reason
        // `<done/>` is its own tag: an interrupt is a distinct kind of event
        // with its own sources, and a tag is what lets its attributes carry
        // meaning rather than be keys in a generic bag.
        const content = render([entry("axon:interrupt", { reason: "user" })])
        expect(content).toContain(`<interrupt reason="user"/>`)
        expect(content).not.toContain(`<system type="interrupt"`)
    })

    it("names the surface an interrupt came from, when there is one", () => {
        const content = render([entry("axon:interrupt", { reason: "user", from: "terminal" })])
        expect(content).toContain(`<interrupt from="terminal" reason="user"/>`)
    })

    it("omits `from` for a shutdown, which no surface asked for", () => {
        const content = render([entry("axon:interrupt", { reason: "shutdown" })])
        expect(content).toContain(`<interrupt reason="shutdown"/>`)
        expect(content).not.toContain("from=")
    })

    it("renders cognet:stimulus:audio via its transcript digest", () => {
        const content = render([entry("cognet:stimulus:audio", {
            channel: "mic",
            ref: { uri: "blob://x", mime: "audio/wav" },
            transcript: "spoken words",
        })])
        expect(content).toContain("spoken words")
    })

    it("escapes angle brackets in text content", () => {
        const content = render([entry("cognet:stimulus:text", { channel: "user", content: "<script>alert(1)</script>" })])
        expect(content).not.toContain("<script>alert(1)</script>")
        expect(content).toContain("&lt;script&gt;")
    })

    it("renders no user message when the history is empty", () => {
        const messages = Air().render({ history: [] })
        expect(messages.some(m => m.role === "user")).toBe(false)
    })
})

let seq = 0
function entry<K extends keyof AxonEntryEvent>(type: K, data: AxonEntryEvent[K], runId?: string): AxonEntry {
    return {
        id: `e${seq}`,
        type,
        time: { ms: seq, seq: seq++ },
        context: { agentId: "a", sessionId: "s", ...(runId ? { runId } : {}) },
        data,
    } as AxonEntry
}

/**
 * One model message renders as ONE <agent> turn.
 *
 * The bug this guards: every entry wrapped itself in its own <agent> tag, so a
 * reply containing a template AND a script came back as two turns with the
 * script's stdout interleaved between them. A model reading that history saw a
 * template it had written blind sitting after a result — indistinguishable
 * from one derived from it — and on the next turn treated its own guess as an
 * established finding it had already delivered.
 *
 * The record the model reasons from has to match what it actually did.
 */
describe("Air render: timeline turn grouping", () => {
    function render(entries: AxonEntry[]): string {
        return asDocument(() => Air().render({ history: entries }))
            .find(m => m.content.startsWith("<timeline>"))?.content ?? ""
    }

    /** Rendered structure only — tags in order, contents dropped. */
    function skeleton(timeline: string): string[] {
        return timeline
            .split("\n")
            .map(line => line.trim())
            .filter(line => /^<\/?(agent|stdout|text|script)/.test(line))
            .map(line => line.replace(/\s+.*?>$/, ">").replace(/>.*$/, ">"))
    }

    it("folds a template and a script from one wake into a single agent turn", () => {
        const run = "wake-1"
        const timeline = render([
            entry("cognet:stimulus:text", { channel: "user", content: "hi" } as never),
            entry("cognet:output:text", { channel: "reply", content: "Let me read that file." } as never, run),
            entry("cognet:action:typescript", { id: "x1", content: 'await fs.read("a.md")' } as never, run),
        ])

        expect(skeleton(timeline)).toEqual([
            "<text>", "</text>",
            "<agent>", "<text>", "</text>", "<script>", "</script>", "</agent>",
        ])
    })

    it("keeps stdout outside the agent turn — the world answering is not the agent speaking", () => {
        const run = "wake-1"
        const timeline = render([
            entry("cognet:action:typescript", { id: "x1", content: "1 + 1" } as never, run),
            entry("cognet:action:result", { id: "x1", ok: true, content: "2" } as never, run),
        ])

        expect(skeleton(timeline)).toEqual(["<agent>", "<script>", "</script>", "</agent>", "<stdout>", "</stdout>"])
    })

    it("separates turns from different wakes", () => {
        const timeline = render([
            entry("cognet:output:text", { channel: "reply", content: "first" } as never, "wake-1"),
            entry("cognet:output:text", { channel: "reply", content: "second" } as never, "wake-2"),
        ])

        expect(skeleton(timeline)).toEqual([
            "<agent>", "<text>", "</text>", "</agent>",
            "<agent>", "<text>", "</text>", "</agent>",
        ])
    })

    it("never folds entries that carry no wake id", () => {
        // An entry whose origin is unknown must not be absorbed into a
        // neighbour's turn — that would claim the model said things together
        // that it may not have.
        const timeline = render([
            entry("cognet:output:text", { channel: "reply", content: "first" } as never),
            entry("cognet:output:text", { channel: "reply", content: "second" } as never),
        ])

        expect(skeleton(timeline)).toEqual([
            "<agent>", "<text>", "</text>", "</agent>",
            "<agent>", "<text>", "</text>", "</agent>",
        ])
    })
})

/**
 * A retry's context must not accumulate the replies it is complaining about.
 *
 * Every failed attempt commits a format-violation quoting the malformed reply.
 * Rendered in full, the third attempt reads its own two previous garbage
 * replies and is asked not to produce garbage — which normalises exactly the
 * output the diagnostic exists to correct.
 */
describe("Air render: format violations", () => {
    function render(entries: AxonEntry[]): string {
        return asDocument(() => Air().render({ history: entries }))
            .find(m => m.content.startsWith("<timeline>"))?.content ?? ""
    }

    const violation = (content: string): AxonEntry =>
        entry("axon:system:message", { type: "format-violation", lang: "txt", content })

    it("renders a single violation", () => {
        const content = render([violation("OUTPUT_EMPTY: first")])
        expect(content).toContain("OUTPUT_EMPTY: first")
    })

    it("keeps only the newest violation when several accumulate", () => {
        const content = render([
            violation("OUTPUT_EMPTY: first"),
            violation("OUTPUT_EMPTY: second"),
            violation("OUTPUT_EMPTY: third"),
        ])
        expect(content).toContain("OUTPUT_EMPTY: third")
        expect(content).not.toContain("OUTPUT_EMPTY: first")
        expect(content).not.toContain("OUTPUT_EMPTY: second")
    })

    it("shows the rejected reply as the blocks it was, marked rejected", () => {
        const content = render([
            entry("axon:system:malformed", {
                content: "<script>a</script><script>b</script>",
                code: "OUTPUT_TOO_MANY_BLOCKS",
                attempt: 1,
            }),
            violation("OUTPUT_TOO_MANY_BLOCKS: too many"),
        ])
        // The model must see the tags it actually sent, not an escaped
        // rendering of them — it is being asked to correct that exact text.
        expect(content).toContain(`<script status="rejected">a</script>`)
        expect(content).toContain(`<script status="rejected">`)
        expect(content).toContain("OUTPUT_TOO_MANY_BLOCKS: too many")
    })

    it("frames a reply with no recognisable block, so it is still visible", () => {
        const content = render([
            entry("axon:system:malformed", {
                content: "I will check the loader next.",
                code: "OUTPUT_EMPTY",
                attempt: 1,
            }),
        ])
        // On an OUTPUT_EMPTY the stray prose IS the reply — dropping it would
        // show the model a rejection with nothing in it.
        expect(content).toContain("I will check the loader next.")
        expect(content).toContain(`status="rejected"`)
    })

    it("drops a rejected exchange once a later wake has begun", () => {
        const content = render([
            entry("axon:system:malformed", { content: "<script>old</script>", code: "OUTPUT_EMPTY", attempt: 1 }, "run-1"),
            entry("axon:system:message", { type: "format-violation", lang: "md", content: "OLD CORRECTION" }, "run-1"),
            entry("cognet:output:text", { channel: "reply", content: "recovered" }, "run-1"),
            entry("cognet:stimulus:text", { channel: "user", content: "next question" }, "run-2"),
        ])
        expect(content).toContain("next question")
        expect(content).not.toContain("<script>old</script>")
        expect(content).not.toContain("OLD CORRECTION")
    })

    it("keeps the whole exchange within the wake it happened in", () => {
        const content = render([
            entry("axon:system:malformed", { content: "<script>bad</script>", code: "OUTPUT_EMPTY", attempt: 1 }, "run-1"),
            entry("axon:system:message", { type: "format-violation", lang: "md", content: "THE CORRECTION" }, "run-1"),
            entry("cognet:output:text", { channel: "reply", content: "recovered" }, "run-1"),
        ])
        // Bad output, correction, then the corrected reply — a worked example,
        // and the reason the exchange is kept rather than collapsed.
        expect(content).toContain(`<script status="rejected">bad</script>`)
        expect(content).toContain("THE CORRECTION")
        expect(content).toContain("recovered")
    })

    it("leaves other system messages alone", () => {
        const content = render([
            entry("axon:system:message", { type: "hot-reload", lang: "txt", content: "reloaded once" }),
            entry("axon:system:message", { type: "hot-reload", lang: "txt", content: "reloaded twice" }),
            violation("OUTPUT_EMPTY: only one"),
        ])
        expect(content).toContain("reloaded once")
        expect(content).toContain("reloaded twice")
        expect(content).toContain("OUTPUT_EMPTY: only one")
    })
})

/**
 * Every block names its own content kind.
 *
 * A model attends better to content whose kind is declared before it starts
 * reading — prose, code and captured output are different things to parse, and
 * the tag alone does not say which. `<system>` carried `lang` from the start;
 * this asserts the rest do too.
 */
describe("Air render: every block declares its lang", () => {
    function render(entries: AxonEntry[]): string {
        return asDocument(() => Air().render({ history: entries }))
            .find(m => m.content.startsWith("<timeline>"))?.content ?? ""
    }

    it("labels a user turn, an agent turn, a script and its stdout", () => {
        const content = render([
            entry("cognet:stimulus:text", { channel: "user", content: "hello" }),
            entry("cognet:output:text", { channel: "reply", content: "hi" }),
            entry("cognet:action:typescript", { id: "x", content: "1+1" }),
            entry("cognet:action:result", { for: "x", ok: true, content: "2" }),
        ])

        expect(content).toContain(`<text from="user" id="u1" channel="user" lang="md">`)
        expect(content).toContain(`<text from="agent" lang="md">`)
        expect(content).toContain(`<script from="agent" id="e1" lang="typescript">`)
        expect(content).toContain(`<stdout for="e1" lang="txt"`)
    })

    it("carries a declared text format onto the turn", () => {
        const content = render([
            entry("cognet:stimulus:text", { channel: "api", content: `{"cmd":"stop"}`, format: "json" }),
        ])
        expect(content).toContain(`lang="json"`)
    })
})

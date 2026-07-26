import type { AxonEntry, AxonEntryEvent } from "@arcforge/types"
import { Air } from "../../../../../src/platform/air"

/**
 * Timeline rendering takes DOMAIN entries (AxonEntry[]) and owns the
 * translation internally. These tests feed real entries and assert the
 * rendered <timeline> — exercising the exhaustive switch that is the single
 * chokepoint between memory format (stimulus, output, action, system entries)
 * and wire format.
 */
describe("Air render: timeline", () => {
    function render(entries: AxonEntry[]): string {
        const messages = Air().render({ history: entries })
        return messages.find(m => m.role === "user")?.content ?? ""
    }

    it("renders a cognet:stimulus:text as a user turn", () => {
        const content = render([entry("cognet:stimulus:text", { source: { channel: "user" }, content: "hello" })])
        expect(content).toContain(`<user id="u1">`)
        expect(content).toContain("hello")
    })

    it("renders cognet:output:text as an agent text turn", () => {
        const content = render([entry("cognet:output:text", { content: "hi there" })])
        expect(content).toContain("<agent>")
        expect(content).toContain("<text>")
        expect(content).toContain("hi there")
    })

    it("renders cognet:action:typescript with a short sequential id, not the raw id", () => {
        const content = render([entry("cognet:action:typescript", { id: "raw-uuid-123", content: "1+1" })])
        expect(content).toContain(`<typescript id="e1">`)
        expect(content).not.toContain("raw-uuid-123")
    })

    it("maps a result's `for` to the same short id as its execute block", () => {
        const content = render([
            entry("cognet:action:typescript", { id: "raw-uuid-123", content: "1+1" }),
            entry("cognet:action:result", { for: "raw-uuid-123", ok: true, content: "2" }),
        ])
        expect(content).toContain(`<typescript id="e1">`)
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

    it("renders axon:interrupt through the typed system emitter", () => {
        const content = render([entry("axon:interrupt", { reason: "user" })])
        expect(content).toContain(`<system type="interrupt" lang="txt">`)
        expect(content).toContain("interrupted (user)")
    })

    it("renders cognet:stimulus:audio via its transcript digest", () => {
        const content = render([entry("cognet:stimulus:audio", {
            source: { channel: "mic" },
            ref: { uri: "blob://x", mime: "audio/wav" },
            transcript: "spoken words",
        })])
        expect(content).toContain("spoken words")
    })

    it("escapes angle brackets in text content", () => {
        const content = render([entry("cognet:stimulus:text", { source: { channel: "user" }, content: "<script>alert(1)</script>" })])
        expect(content).not.toContain("<script>alert(1)</script>")
        expect(content).toContain("&lt;script&gt;")
    })

    it("renders no user message when the history is empty", () => {
        const messages = Air().render({ history: [] })
        expect(messages.some(m => m.role === "user")).toBe(false)
    })
})

let seq = 0
function entry<K extends keyof AxonEntryEvent>(type: K, data: AxonEntryEvent[K]): AxonEntry {
    return { id: `e${seq}`, type, time: { ms: seq, seq: seq++ }, context: { agentId: "a", sessionId: "s" }, data } as AxonEntry
}

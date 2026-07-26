import { Air } from "../../../../../src/platform/air"

describe("Air render: sections", () => {
    it("always renders a meta section as a system message", () => {
        const messages = Air().render({})
        const meta = messages.find(m => m.content.startsWith("<meta>"))
        expect(meta?.role).toBe("system")
    })

    it("describes the agent as living in a persistent native process", () => {
        const meta = Air().render({}).find(m => m.content.startsWith("<meta>"))?.content ?? ""

        expect(meta).toContain("persistent Bun")
        expect(meta).toContain("process.chdir(path)")
        expect(meta).toContain("not an exhaustive declaration of standard Bun or Node APIs")
        expect(meta).toContain("TypeScript syntax is accepted")
        expect(meta).not.toContain("<env>")
        expect(meta).not.toContain("<state>")
    })

    it("makes <done/> a mandatory, unconditional close to every message", () => {
        const contract = Air().render({}).find(m => m.content.startsWith("<contract>"))?.content ?? ""

        expect(contract).toMatch(/no exceptions/i)
        expect(contract).toContain("&lt;done/&gt;")
    })

    it("renders an empty system block when no base is given", () => {
        const messages = Air().render({})
        expect(messages.some(m => m.content === "<system></system>")).toBe(true)
    })

    it("renders the given base inside the system block", () => {
        const messages = Air().render({ base: "You are a helpful agent." })
        expect(messages.some(m => m.content.includes("You are a helpful agent."))).toBe(true)
    })

    it("always renders a contract section", () => {
        const messages = Air().render({})
        expect(messages.some(m => m.content.startsWith("<contract>"))).toBe(true)
    })

    it("renders no scope section when no scope is given", () => {
        const messages = Air().render({})
        expect(messages.some(m => m.content.startsWith("<scope"))).toBe(false)
    })

    it("renders no env or state sections — those blocks were removed", () => {
        const messages = Air().render({ base: "x" })
        expect(messages.some(m => m.content.startsWith("<env>"))).toBe(false)
        expect(messages.some(m => m.content.startsWith("<state>"))).toBe(false)
    })

    it("section order is meta → scope → system → contract → timeline", () => {
        const messages = Air().render({
            base: "sys",
            scope: { modules: [{ name: "fs", members: [{ name: "read", declaration: "function read(p: string): Promise<string>" }] }] },
            history: [threadEntry("cognet:stimulus:text", { source: { channel: "user" }, content: "hi" })],
        })
        const tags = messages.map(m => m.content.match(/^<(\w+)/)?.[1] ?? m.content.slice(0, 6))
        expect(tags).toEqual(["meta", "scope", "system", "contract", "timeline"])
    })
})

// minimal enveloped entry for render tests
function threadEntry(type: string, data: unknown) {
    return { id: type, type, time: { ms: 0, seq: 0 }, context: { agentId: "a", sessionId: "s" }, data } as never
}

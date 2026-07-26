import { err } from "../src/err"

describe("AxonError.render()", () => {
    it("prints a full report with source context around the call site", () => {
        function deepInside() {
            return err("ENGINE_MISSING")
        }
        const e = deepInside()

        console.log(e.render())

        // The code stays a real field on the object (for a TUI to badge,
        // filter, or link to docs by) even though the default CLI render
        // doesn't print it inline — title + description read as prose.
        expect(e.code).toBe("AX-ENGINE-001")
        expect(e.render()).toContain(`Axon Error: ${e.title}`)
        expect(e.render()).toContain(e.description)
    })

    it("prints a cause chain and structured context when both are attached", () => {
        const original = new Error("ECONNREFUSED: could not reach registry")
        const e = err("PROMPT_FILE_NOT_FOUND", {
            detail: "prompt file for \"greeting\" is missing",
            context: { path: "/agent/src/prompts/greet.vue" },
            cause: original,
        })

        console.log(e.render())

        expect(e.render()).toContain("prompt file for \"greeting\" is missing")
        expect(e.render()).toContain("Context:")
        expect(e.render()).toContain("path: /agent/src/prompts/greet.vue")
        expect(e.render()).toContain("Caused by")
        expect(e.render()).toContain("ECONNREFUSED")
    })

    it("never throws when context contains a circular reference", () => {
        const circular: Record<string, unknown> = { name: "greeting" }
        circular.self = circular
        const e = err("PROMPT_NOT_FOUND", { context: circular })

        expect(() => e.render()).not.toThrow()
        console.log(e.render())
    })

    it("renders at least one frame from a nested call, pointing at real source", () => {
        // Bun/JSC may inline intermediate calls (level2 here never appears
        // in the raw stack) — frame COUNT isn't something call-site code
        // can rely on, only that the innermost real frame is captured and
        // points at this file.
        function level2() {
            return err("SCRIPT_NOT_FOUND")
        }
        function level1() {
            return level2()
        }
        const e = level1()

        console.log(e.render())

        expect(e.frames.length).toBeGreaterThan(0)
        expect(e.frames[0]?.fileName).toContain("render.test.ts")
    })
})

import { mkdtemp, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { err } from "../src/err"
import { parseStack } from "../src/stack"
import { describe, it, test, expect } from "bun:test"

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

/**
 * Whose fault is it?
 *
 * `axon publish` outside a project directory printed eighty lines of OUR call
 * stack under a message that already said everything actionable — telling the
 * user to debug software they did not write. Expected failures render as the
 * message alone; everything else keeps the full diagnostic.
 */
describe("expected failures render without our internals", () => {
    it("prints only what the user can act on", () => {
        const e = err("PROJECT_NOT_FOUND", { context: { path: "/home/cody/git/arclabs" } })
        const out = e.render()

        // The whole message: what happened, and where.
        expect(out).toContain("Axon Error: Project Not Found")
        expect(out).toContain("path: /home/cody/git/arclabs")

        // ...and none of our machinery. Matched on the frame marker
        // ("\nat ", how renderFrame starts a line) rather than " at ", which
        // appears in ordinary prose — "was found at this path".
        expect(out).not.toContain("─".repeat(10))
        expect(out).not.toContain("\nat ")
        expect(out).not.toContain("packages/err/src")
    })

    it("still carries its frames on the object for anything that wants them", () => {
        // Suppressed from THIS renderer, not discarded — a devtools surface or
        // a bug report can still read them.
        const e = err("PROJECT_NOT_FOUND")

        expect(e.expected).toBe(true)
        expect(e.frames.length).toBeGreaterThan(0)
    })

    it("keeps a cause chain, which names the real underlying fault", () => {
        // "the file is missing" caused by ECONNREFUSED is a network problem
        // wearing a filesystem message. Dropping the cause would hide the one
        // line that explains it.
        const e = err("PROMPT_FILE_NOT_FOUND", { cause: new Error("ECONNREFUSED: could not reach registry") })

        expect(e.render()).toContain("ECONNREFUSED")
    })
})

describe("unexpected failures keep the full diagnostic", () => {
    it("prints frames and source snippets", () => {
        // The default. An unclassified failure IS ours, and this is what makes
        // it debuggable from a pasted terminal log.
        const out = err(new Error("something genuinely broke")).render()

        expect(out).toContain("─".repeat(10))
        expect(out).toContain("\nat ")
    })

    it("defaults to unexpected when a code does not classify itself", () => {
        // Forgetting the flag costs a noisier message, never a hidden bug.
        const e = err("ENGINE_MISSING")

        expect(e.expected).toBeUndefined()
        expect(e.render()).toContain("\nat ")
    })
})

describe("a minified bundle", () => {
    /**
     * The regression: `readSourceWindow` guarded against a bundle being
     * UNREADABLE, but a published bundle is readable and minified — one line
     * is hundreds of kilobytes. Every unclassified error in a released build
     * printed three of them, burying the actual message under a wall of
     * generated code.
     */
    test("produces no source snippet", async () => {
        const dir = await mkdtemp(join(tmpdir(), "err-minified-"))
        try {
            // One line, far past anything real source produces.
            const file = join(dir, "bundle.js")
            writeFileSync(file, `${"var a=1;".repeat(60_000)}\nexport{}\n`)

            const frames = parseStack(`Error: boom\n    at thing (${file}:1:10)`)

            expect(frames.length).toBeGreaterThan(0)
            expect(frames[0]!.source).toBeNull()
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("still captures a snippet from ordinary source", async () => {
        const dir = await mkdtemp(join(tmpdir(), "err-plain-"))
        try {
            const file = join(dir, "plain.ts")
            writeFileSync(file, "const a = 1\nconst b = 2\nthrow new Error('x')\n")

            const frames = parseStack(`Error: boom\n    at thing (${file}:2:7)`)

            expect(frames[0]!.source).not.toBeNull()
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

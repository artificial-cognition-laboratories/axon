import type { AxonScope, AxonScopeModule } from "@arcforge/types"
import { Air } from "../../src"

/** Only renderer of the capsule's authoritative TypeScript scope. */
describe("Air render: scope", () => {
    function rendered(...modules: AxonScopeModule[]): string | undefined {
        const scope: AxonScope = { modules }
        return Air().render({ scope }).find(message => message.content.startsWith("<scope"))?.content
    }

    it("omits an empty scope", () => {
        expect(rendered({ name: "empty", members: [] })).toBeUndefined()
    })

    describe("required output", () => {
        function withOutput(output: string, ...modules: AxonScopeModule[]): string | undefined {
            const scope: AxonScope = { modules }
            return Air().render({ scope, output })
                .find(message => message.content.startsWith("<scope"))?.content
        }

        it("renders the required shape beside the tools", () => {
            const out = withOutput("declare const result: { files: number }", {
                name: "web",
                members: [{ name: "fetch", declaration: "function fetch(url: string): Promise<string>" }],
            })
            expect(out).toContain("declare function fetch(url: string): Promise<string>")
            expect(out).toContain("declare const result: { files: number }")
            expect(out).toContain("REQUIRED")
        })

        // The shape is the whole instruction when an agent has no tools —
        // omitting the block would leave the model no target at all.
        it("renders a scope for the output alone when no tools exist", () => {
            const out = withOutput("declare const result: string")
            expect(out).toContain("declare const result: string")
        })

        it("puts the required shape after the capabilities that reach it", () => {
            const out = withOutput("declare const result: { n: number }", {
                name: "web",
                members: [{ name: "fetch", declaration: "function fetch(url: string): Promise<string>" }],
            })!
            expect(out.indexOf("namespace web")).toBeLessThan(out.indexOf("result"))
        })

        it("renders no output section when none is required", () => {
            const out = rendered({
                name: "web",
                members: [{ name: "fetch", declaration: "function fetch(url: string): Promise<string>" }],
            })
            expect(out).not.toContain("REQUIRED")
        })
    })

    it("renders a module's members as top-level globals, never a namespace", () => {
        const out = rendered({
            name: "web",
            description: "Web access",
            members: [{ name: "fetch", declaration: "function fetch(url: string): Promise<string>", jsdoc: "Fetch a URL." }],
        })
        expect(out).toContain(`<scope lang="ts">`)
        // The module NAME groups the block for the reader; it is never a
        // namespace the model addresses through — every export is callable
        // under its own name.
        expect(out).not.toContain("declare namespace")
        expect(out).toContain("declare function fetch(url: string): Promise<string>")
        expect(out).toContain("/** Fetch a URL. */")
        expect(out).toContain("/** Web access */")
    })

    it("renders capsule globals and their ambient types", () => {
        const out = rendered({
            name: "capsule",
            ambientTypes: ["interface CapsuleProcess { cwd(): string }"],
            members: [{ name: "process", declaration: "const process: CapsuleProcess" }],
        })
        expect(out).toContain("interface CapsuleProcess")
        expect(out).toContain("declare const process: CapsuleProcess")
        expect(out).not.toContain("declare namespace capsule")
    })

    it("can describe a native runtime type without expanding its standard interface", () => {
        const out = rendered({
            name: "capsule",
            description: "Persistent native runtime",
            members: [{
                name: "process",
                declaration: "const process: NodeJS.Process & { run(command: string): Promise<unknown> }",
                jsdoc: "Your native process object. Standard Node APIs remain available.",
            }],
        })

        expect(out).toContain("declare const process: NodeJS.Process &")
        expect(out).toContain("Standard Node APIs remain available")
        expect(out).not.toContain("interface NodeJS.Process")
    })

    it("deduplicates ambient declarations across modules", () => {
        const ambient = "type Shared = string"
        const out = rendered(
            { name: "a", ambientTypes: [ambient], members: [{ name: "one", declaration: "function one(): Shared" }] },
            { name: "b", ambientTypes: [ambient], members: [{ name: "two", declaration: "function two(): Shared" }] },
        )!
        expect(out.split(ambient)).toHaveLength(2)
    })
})

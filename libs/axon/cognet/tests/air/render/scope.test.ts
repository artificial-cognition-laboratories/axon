import type { AxonScope, AxonScopeModule } from "@arcforge/types"
import { Air } from "../../../src/air"

/** Only renderer of the capsule's authoritative TypeScript scope. */
describe("Air render: scope", () => {
    function rendered(...modules: AxonScopeModule[]): string | undefined {
        const scope: AxonScope = { modules }
        return Air().render({ scope }).find(message => message.content.startsWith("<scope"))?.content
    }

    it("omits an empty scope", () => {
        expect(rendered({ name: "empty", members: [] })).toBeUndefined()
    })

    it("renders a namespaced module", () => {
        const out = rendered({
            name: "web",
            description: "Web access",
            members: [{ name: "fetch", declaration: "function fetch(url: string): Promise<string>", jsdoc: "Fetch a URL." }],
        })
        expect(out).toContain(`<scope lang="ts">`)
        expect(out).toContain("declare namespace web {")
        expect(out).toContain("function fetch(url: string): Promise<string>")
        expect(out).toContain("/** Fetch a URL. */")
        expect(out).toContain("/** Web access */")
    })

    it("renders flat capsule globals and their ambient types", () => {
        const out = rendered({
            name: "capsule",
            flat: true,
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
            flat: true,
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

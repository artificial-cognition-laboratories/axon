import type { AxonTool } from "@arcforge/types"
import { isLoadable, scopeToDts, toScope } from "@arcforge/core"
import { renderScope } from "@arcforge/air"
import { describe, it, expect } from "bun:test"

/**
 * The model's <scope> and the editor's ambient declarations must never
 * disagree about WHAT is in scope. They cannot, because neither decides
 * it — toScope() does, once, and both render its result.
 *
 * These pin that property. It is the one that broke: the capsule filtered
 * for loadability while the .d.ts generator rendered every scanned tool,
 * so the file described a scope the model never had.
 */

function tool(over: Partial<AxonTool> & Pick<AxonTool, "name">): AxonTool {
    return {
        fns: [{ name: over.name, declaration: `function ${over.name}(): void` }],
        origin: "src",
        ...over,
    } as AxonTool
}

const blueprint = (tools: AxonTool[]) => ({ tools }) as never

describe("scope: one membership decision, two spellings", () => {
    it("a tool with a real entry file is in scope", () => {
        const scope = toScope(blueprint([tool({ name: "greet", entryPath: "/a/src/tools/greet.ts" })]))
        expect(scope.modules.map(m => m.name)).toEqual(["greet"])
    })

    it("inline source counts as loadable — programmatic blueprints still work", () => {
        const scope = toScope(blueprint([tool({ name: "inline", source: "export function inline() {}" })]))
        expect(scope.modules.map(m => m.name)).toEqual(["inline"])
    })

    it("a tool the capsule cannot load is excluded", () => {
        expect(isLoadable(tool({ name: "ghost" }))).toBe(false)
        expect(toScope(blueprint([tool({ name: "ghost" })])).modules).toEqual([])
    })

    /**
     * The regression itself: declaring something the capsule cannot call
     * would tell the model to invoke a function that exists nowhere.
     */
    it("both renderers agree on membership, always", () => {
        const tools = [
            tool({ name: "real", entryPath: "/a/src/tools/real.ts" }),
            tool({ name: "unloadable" }),
        ]
        const scope = toScope(blueprint(tools))

        const model = renderScope(scope)
        const editor = scopeToDts(scope)

        expect(model).toContain("real")
        expect(editor).toContain("real")
        expect(model).not.toContain("unloadable")
        expect(editor).not.toContain("unloadable")
    })

    it("ambient types are emitted to both surfaces, deduped", () => {
        const scope = toScope(blueprint([
            tool({ name: "a", entryPath: "/a.ts", ambientTypes: ["type Shared = { x: number }"] }),
            tool({ name: "b", entryPath: "/b.ts", ambientTypes: ["type Shared = { x: number }"] }),
        ]))

        const editor = scopeToDts(scope)
        expect(editor.split("type Shared").length - 1).toBe(1)
        expect(renderScope(scope).split("type Shared").length - 1).toBe(1)
    })

    it("declares a tool the same way whatever its origin", () => {
        // Placement used to follow ORIGIN — an agent's own tools flat, a
        // MODULE's under the module's name — and both renderers spelled that
        // wrap. It disagreed with the runtime in practice: a registry module
        // exporting one object named after its own file declared
        // `subagents.subagents.request()`, which an editor accepted, a model
        // read off these types and called, and the runtime did not have.
        //
        // It was also wrong on its own terms. Conditional placement makes a
        // call site depend on provenance, so moving a tool into a module
        // silently rewrites every caller — not the author's choice to make.
        // A tool exporting an object is already its own namespace; a name two
        // tools both claim is reported (Tools.onClash), not worked around.
        const own = scopeToDts(toScope(blueprint([tool({ name: "f", entryPath: "/f.ts", origin: "src" })])))
        const installed = scopeToDts(toScope(blueprint([tool({ name: "f", entryPath: "/f.ts", origin: "module" })])))

        expect(own).toContain("function f(): void")
        // Byte-identical: origin is no longer an input to the spelling.
        expect(installed).toBe(own)
    })

    it("an empty scope renders nothing rather than an empty block", () => {
        expect(renderScope(toScope(blueprint([])))).toBe("")
    })
})

import { describe, expect, test } from "bun:test"
import type { AxonScope, AxonScopeModule } from "@arcforge/types"
import { scopeToDts } from "@arcforge/core"
import { renderScope } from "@arcforge/air"

/**
 * Two spellings of one scope, and they must never disagree.
 *
 * toScope() decides membership once (pinned in blueprint/scope.test.ts). Two
 * renderers then spell that result for two audiences: renderScope() writes the
 * <scope> block the model reads, scopeToDts() writes the tool-globals.d.ts an
 * editor reads. Both source files say in their own comments that they must
 * differ only in spelling, never in content — this file is what actually holds
 * them to it.
 *
 * The failure mode is asymmetric and nasty. If the editor declares something
 * the model was never told about, the author writes code against a tool the
 * agent cannot see. If the model is told about something the editor does not
 * declare, the author's own scripts do not typecheck against their agent's
 * real scope. Neither shows up as an error anywhere — both surfaces look
 * internally consistent.
 *
 * The other property here is SELF-CONTAINMENT: every type named in a rendered
 * declaration must be defined within the same rendered block. A signature
 * mentioning a type whose definition never travels leaves the model reading a
 * name it cannot resolve, and an editor with a dangling reference.
 */

const member = (name: string, declaration: string, jsdoc?: string) => ({
    name,
    declaration,
    ...(jsdoc !== undefined ? { jsdoc } : {}),
})

const mod = (over: Partial<AxonScopeModule> & Pick<AxonScopeModule, "name" | "members">): AxonScopeModule =>
    over as AxonScopeModule

const scope = (...modules: AxonScopeModule[]): AxonScope => ({ modules })

/** Type names a rendered block references but never defines. */
function danglingTypes(rendered: string, names: string[]): string[] {
    return names.filter(name => {
        const referenced = new RegExp(`:\\s*(Promise<)?${name}\\b`).test(rendered)
        const defined = new RegExp(`\\b(type|interface|class)\\s+${name}\\b`).test(rendered)
        return referenced && !defined
    })
}

// ─── The two renderers agree ─────────────────────────────────────────────────

describe("scope rendering: model and editor never disagree", () => {
    test("both spell the same flat member set", () => {
        const s = scope(mod({ name: "math", members: [member("add", "function add(a: number): Promise<number>")] }))

        expect(renderScope(s)).toContain("add")
        expect(scopeToDts(s)).toContain("add")
    })

    test("both spell the same namespaced member set", () => {
        const s = scope(mod({ name: "github", members: [member("openPr", "function openPr(): Promise<void>")] }))

        expect(renderScope(s)).toContain("openPr")
        expect(scopeToDts(s)).toContain("openPr")
    })

    test("every member of every module appears in both spellings", () => {
        const s = scope(
            mod({ name: "math", members: [member("add", "function add(): Promise<number>"), member("sub", "function sub(): Promise<number>")] }),
            mod({ name: "github", members: [member("openPr", "function openPr(): Promise<void>")] }),
        )
        const model = renderScope(s)
        const dts = scopeToDts(s)

        for (const name of ["add", "sub", "openPr"]) {
            expect(model).toContain(name)
            expect(dts).toContain(name)
        }
    })

    test("a module with no members is omitted from both", () => {
        const s = scope(mod({ name: "empty", members: [] }))

        expect(renderScope(s)).not.toContain("empty")
        expect(scopeToDts(s)).not.toContain("namespace empty")
    })

    test("an empty scope renders no block at all for the model", () => {
        expect(renderScope(scope())).toBe("")
    })
})

// ─── Flat vs namespaced is spelled correctly for each audience ───────────────

describe("scope rendering: placement matches how the value is installed", () => {
    test("a flat module's members are top-level globals, not a namespace", () => {
        // src/tools/ is flat: the capsule installs each export directly on
        // globalThis, so the agent calls `add(1, 2)` and never `math.add`.
        const s = scope(mod({ name: "math", members: [member("add", "function add(): Promise<number>")] }))

        expect(renderScope(s)).not.toContain("namespace math")
        expect(scopeToDts(s)).not.toContain("namespace math")
    })

    test("an installed module's members render as globals too, not a namespace", () => {
        // A module name groups its exports for the reader; it is not a
        // namespace the model addresses through. `openPr()`, not
        // `github.openPr()` — the same rule as the agent's own tools.
        const s = scope(mod({ name: "github", members: [member("openPr", "function openPr(): Promise<void>")] }))

        expect(renderScope(s)).not.toContain("namespace github")
        expect(scopeToDts(s)).not.toContain("namespace github")
        expect(scopeToDts(s)).toContain("function openPr(): Promise<void>")
    })

    test("every module in a scope places its members the same way", () => {
        const s = scope(
            mod({ name: "math", members: [member("add", "function add(): Promise<number>")] }),
            mod({ name: "github", members: [member("openPr", "function openPr(): Promise<void>")] }),
        )
        const dts = scopeToDts(s)

        // One placement rule, no per-module variation to remember.
        expect(dts).not.toContain("namespace")
        expect(dts).toContain("function add(): Promise<number>")
        expect(dts).toContain("function openPr(): Promise<void>")
    })
})

// ─── Self-containment: nothing dangles ───────────────────────────────────────

describe("scope rendering: every referenced type is defined in the same block", () => {
    test("an ambient type is inlined for both audiences", () => {
        const s = scope(mod({
            name: "tasks",
            ambientTypes: ["type Task = { id: string }"],
            members: [member("next", "function next(): Promise<Task>")],
        }))

        expect(renderScope(s)).toContain("type Task")
        expect(scopeToDts(s)).toContain("type Task")
    })

    test("a type shared by two modules is inlined once, not twice", () => {
        const shared = "type Shared = { x: number }"
        const s = scope(
            mod({ name: "a", ambientTypes: [shared], members: [member("one", "function one(): Promise<Shared>")] }),
            mod({ name: "b", ambientTypes: [shared], members: [member("two", "function two(): Promise<Shared>")] }),
        )

        expect(renderScope(s).split("type Shared").length - 1).toBe(1)
        expect(scopeToDts(s).split("type Shared").length - 1).toBe(1)
    })

    test("a class carried as an ambient type is rendered for both", () => {
        // The user-reported shape: a tool returning a class from the project's
        // own lib/. Once the class travels, both audiences must spell it.
        const s = scope(mod({
            name: "dice",
            ambientTypes: ["class Roll {\n    total: number;\n}"],
            members: [member("roll", "function roll(): Promise<Roll>")],
        }))

        expect(renderScope(s)).toContain("class Roll")
        expect(scopeToDts(s)).toContain("class Roll")
    })

    test("no member declaration references a type the block never defines", () => {
        // The invariant that catches the Roll bug at the render boundary,
        // independent of whether the declare stage remembered to carry it.
        const s = scope(mod({
            name: "dice",
            ambientTypes: ["class Roll {\n    total: number;\n}"],
            members: [member("roll", "function roll(): Promise<Roll>")],
        }))

        expect(danglingTypes(renderScope(s), ["Roll"])).toEqual([])
        expect(danglingTypes(scopeToDts(s), ["Roll"])).toEqual([])
    })

    test("a signature naming an uncarried type is a detectable dangle", () => {
        // Guards the detector itself: if danglingTypes() could not see this
        // case, the test above would pass vacuously.
        const s = scope(mod({ name: "dice", members: [member("roll", "function roll(): Promise<Roll>")] }))

        expect(danglingTypes(renderScope(s), ["Roll"])).toEqual(["Roll"])
    })
})

// ─── Documentation reaches the model ─────────────────────────────────────────

describe("scope rendering: JSDoc is the model's documentation", () => {
    test("member JSDoc is rendered for both audiences", () => {
        const s = scope(mod({
            name: "search",
            members: [member("find", "function find(q: string): Promise<string[]>", "Search the tracker. At most 20 results.")],
        }))

        expect(renderScope(s)).toContain("Search the tracker")
        expect(scopeToDts(s)).toContain("Search the tracker")
    })

    test("multi-line JSDoc survives rendering", () => {
        const s = scope(mod({
            name: "search",
            members: [member("find", "function find(): Promise<void>", "Line one.\nLine two.")],
        }))

        expect(renderScope(s)).toContain("Line one.")
        expect(renderScope(s)).toContain("Line two.")
    })

    test("a module description is rendered when present", () => {
        const s = scope(mod({
            name: "github",
            description: "GitHub operations for the configured repo.",
            members: [member("openPr", "function openPr(): Promise<void>")],
        }))

        expect(renderScope(s)).toContain("GitHub operations")
    })
})

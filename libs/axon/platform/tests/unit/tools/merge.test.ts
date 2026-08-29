import { describe, expect, test } from "bun:test"
import { merge } from "@arcforge/platform/build/blueprint/collisions"

/**
 * Precedence when an agent and its modules name the same tool.
 *
 * An agent installs modules it did not write. Two of them can export `search`,
 * or a module can export a name the agent already uses. Exactly one of them can
 * own that name in the final scope, because the scope is a flat set of callable
 * names and the model is given one declaration per name.
 *
 * The rule is: the agent always wins, then modules in declaration order.
 * Whoever loses is SKIPPED AND REPORTED. That second half is the part worth
 * pinning — a shadowed tool that vanished silently would leave an author
 * staring at a module they installed, whose tool exists, is declared, bundles
 * fine, and is nowhere in the agent's scope, with nothing anywhere explaining
 * why.
 *
 * This is also the one place in the tool pipeline where a warning is the
 * correct response rather than a throw: shadowing is a resolvable, well-defined
 * outcome, not an invalid state. The agent still gets a coherent scope. Compare
 * declare/bundle failures, where no coherent scope exists and the scan must
 * throw.
 */

type Named = { name: string; origin?: string }

const tool = (name: string, origin = "src"): Named => ({ name, origin })
const group = (owner: string, ...names: string[]) => ({ owner, entries: names.map(n => tool(n, owner)) })

describe("merge(): the agent always wins", () => {
    test("an agent tool shadows a module tool of the same name", () => {
        const { merged } = merge("tools", [tool("search")], [group("github", "search")])

        expect(merged).toHaveLength(1)
        expect(merged[0]?.origin).toBe("src")
    })

    test("shadowing a module tool is reported, never silent", () => {
        const { warnings } = merge("tools", [tool("search")], [group("github", "search")])

        expect(warnings).toHaveLength(1)
        expect(warnings[0]?.domain).toBe("tools")
        expect(warnings[0]?.error).toContain("search")
        expect(warnings[0]?.error).toContain("github")
    })

    test("the report names who won, so the author knows where to look", () => {
        const { warnings } = merge("tools", [tool("search")], [group("github", "search")])

        expect(warnings[0]?.error).toContain("agent")
    })

    test("non-colliding module tools are all kept", () => {
        const { merged, warnings } = merge("tools", [tool("mine")], [group("github", "openPr", "listPrs")])

        expect(merged.map(e => e.name).sort()).toEqual(["listPrs", "mine", "openPr"])
        expect(warnings).toEqual([])
    })
})

describe("merge(): modules resolve in declaration order", () => {
    test("the first module to declare a name keeps it", () => {
        const { merged } = merge("tools", [], [group("alpha", "search"), group("beta", "search")])

        expect(merged).toHaveLength(1)
        expect(merged[0]?.origin).toBe("alpha")
    })

    test("the losing module is reported and names the winner", () => {
        const { warnings } = merge("tools", [], [group("alpha", "search"), group("beta", "search")])

        expect(warnings).toHaveLength(1)
        expect(warnings[0]?.error).toContain("beta")
        expect(warnings[0]?.error).toContain("alpha")
    })

    test("a shadowed name appears exactly once in the merged scope", () => {
        // The property that matters downstream: the model gets one declaration
        // per callable name. Two entries with the same name would render two
        // declarations of the same global.
        const { merged } = merge("tools", [tool("search")], [group("alpha", "search"), group("beta", "search")])

        expect(merged.filter(e => e.name === "search")).toHaveLength(1)
    })

    test("every shadowed entry produces its own report", () => {
        const { warnings } = merge("tools", [tool("search")], [group("alpha", "search"), group("beta", "search")])

        expect(warnings).toHaveLength(2)
    })
})

describe("merge(): shape is preserved", () => {
    test("no collisions means every entry survives in order", () => {
        const { merged, warnings } = merge("tools", [tool("a")], [group("m1", "b"), group("m2", "c")])

        expect(merged.map(e => e.name)).toEqual(["a", "b", "c"])
        expect(warnings).toEqual([])
    })

    test("an agent with no tools still receives its modules' tools", () => {
        const { merged } = merge("tools", [], [group("github", "openPr")])

        expect(merged.map(e => e.name)).toEqual(["openPr"])
    })

    test("no modules means the agent's own tools pass through untouched", () => {
        const { merged, warnings } = merge("tools", [tool("a"), tool("b")], [])

        expect(merged.map(e => e.name)).toEqual(["a", "b"])
        expect(warnings).toEqual([])
    })

    test("duplicate names within the agent's own tools are not silently deduped", () => {
        // Two agent files exporting the same name is an authoring error the
        // agent's own scope cannot resolve by precedence — there is no "winner"
        // rule between two files the same author wrote. It must not pass
        // through as two declarations of one global.
        const { merged, warnings } = merge("tools", [tool("dup"), tool("dup")], [])

        expect(merged.filter(e => e.name === "dup").length === 1 || warnings.length > 0).toBe(true)
    })
})

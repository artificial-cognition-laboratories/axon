import { escapingImports } from "../../../src/build/project/bundle/imports"
import { describe, it, expect } from "bun:test"

/**
 * A config that imports from outside the project cannot be published: the
 * bundle carries the project and nothing above it, so the file it names is
 * never shipped. It runs locally and dies in the container.
 *
 * These test the DETECTOR against the shapes a real config uses, because the
 * cost of a false negative is a paid-for deployment that cannot boot, and the
 * cost of a false positive is a project that cannot be published at all.
 */
describe("escapingImports", () => {
    const root = "/repo/agents/barry"
    const config = "/repo/agents/barry/axon.config.ts"

    const find = (source: string) => escapingImports(source, config, root)

    it("catches the case that shipped: a cognet imported from a sibling tree", () => {
        const found = find(`import Cognet from "../../cognets/zero/cognet.config"\n`)
        expect(found).toHaveLength(1)
        expect(found[0]!.specifier).toBe("../../cognets/zero/cognet.config")
        expect(found[0]!.line).toBe(1)
    })

    it("reports the line, so the message can point at it", () => {
        const found = find(`// a comment\n\nimport X from "../outside"\n`)
        expect(found[0]!.line).toBe(3)
    })

    it("allows an import that stays inside the project", () => {
        expect(find(`import Cognet from "./cognet/cognet.config"\n`)).toEqual([])
    })

    /**
     * A path may leave and come back. A string test for a leading ".." would
     * miss this; resolving and comparing does not.
     */
    it("allows a path that leaves and returns", () => {
        expect(find(`import X from "./a/../src/tools"\n`)).toEqual([])
    })

    it("ignores bare package specifiers, which resolve from node_modules", () => {
        const source = `import { Axon } from "@arcforge/core"\nimport { join } from "node:path"\n`
        expect(find(source)).toEqual([])
    })

    it("catches a dynamic import too", () => {
        const found = find(`const mod = await import("../../shared/util")\n`)
        expect(found).toHaveLength(1)
        expect(found[0]!.specifier).toBe("../../shared/util")
    })

    it("catches a re-export", () => {
        const found = find(`export { thing } from "../../lib/thing"\n`)
        expect(found).toHaveLength(1)
    })

    it("reports every offending import, not just the first", () => {
        const source = `import A from "../../one"\nimport B from "../../two"\n`
        expect(find(source).map(entry => entry.specifier)).toEqual(["../../one", "../../two"])
    })
})

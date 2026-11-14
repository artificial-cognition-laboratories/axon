import { describe, expect, it } from "bun:test"
import { stageFor } from "../../src/build/runtime/progress"

describe("build progress", () => {
    it("projects dependency retries onto the dependency boot stage", () => {
        expect(stageFor("build:tree:start")).toBe("dependencies")
    })
})

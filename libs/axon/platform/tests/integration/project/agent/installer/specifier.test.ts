import { parseSpecifier } from "@arcforge/platform/build/project"
import { describe, it, expect } from "bun:test"

describe("parseSpecifier", () => {
    it("parses a scoped name with no version", () => {
        expect(parseSpecifier("@axon/telegram")).toEqual({ name: "@axon/telegram", version: undefined })
    })

    it("parses a scoped name with a version", () => {
        expect(parseSpecifier("@axon/telegram@1.2.0")).toEqual({ name: "@axon/telegram", version: "1.2.0" })
    })

    it("parses a prerelease version", () => {
        expect(parseSpecifier("@axon/telegram@1.2.0-beta.1")).toEqual({ name: "@axon/telegram", version: "1.2.0-beta.1" })
    })

    it("parses a range rather than an exact version", () => {
        expect(parseSpecifier("@axon/telegram@^1.2.0")).toEqual({ name: "@axon/telegram", version: "^1.2.0" })
    })

    it("treats a trailing empty version segment as undefined", () => {
        expect(parseSpecifier("@axon/telegram@")).toEqual({ name: "@axon/telegram", version: undefined })
    })

    // The registry refuses to publish unscoped packages, so an unscoped
    // specifier can never resolve. Failing here names the module; letting it
    // through would surface as a registry 404 about a URL instead.
    it("rejects an unscoped name", () => {
        expect(() => parseSpecifier("telegram")).toThrow()
    })

    it("rejects an unscoped name carrying a version", () => {
        expect(() => parseSpecifier("telegram@1.2.0")).toThrow()
    })
})

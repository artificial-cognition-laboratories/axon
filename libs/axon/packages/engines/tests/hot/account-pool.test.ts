import { describe, expect, it } from "bun:test"
import { providerPool } from "../../src/providers"

describe("account provider inheritance", () => {
    const connected = [{ provider: "anthropic" }, { provider: "openrouter" }]
    it("adds account connections to an unconfigured profile", () => {
        expect(providerPool(undefined, undefined, connected).map(entry => entry.provider))
            .toEqual(["axon", "anthropic", "openrouter", "mock", "local"])
    })
    it("honors an explicit empty or local-only profile", () => {
        expect(providerPool([], undefined, connected).map(entry => entry.provider)).toEqual(["mock", "local"])
        expect(providerPool([{ provider: "ollama" }], undefined, connected).map(entry => entry.provider)).toEqual(["ollama", "mock", "local"])
    })
})

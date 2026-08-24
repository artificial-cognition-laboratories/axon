import { AxonDriver as Axon } from "../src/drivers"

/**
 * `Axon({ ... })` builds a DEF, and what that def carries is a contract.
 *
 * The driver reads its options from the constructor's closure, which is fine
 * for streaming — but with `model: "auto"` the real model is chosen
 * server-side, so a client asking "what am I running on"
 * (cloud.engine.resolve) has to read the selection inputs OFF THE DEF. A
 * closure is not readable, so anything it alone holds is invisible.
 *
 * That was a real bug: `optimize`/`limit` lived only in the closure, so the
 * TUI header resolved "auto" with DEFAULT weights and confidently displayed a
 * model the agent would never actually use.
 */
describe("Axon() engine def", () => {
    it("identifies its provider as a name", () => {
        // Not `provider` — this is a constructed def, not an EngineRef. Anything
        // reading the provider has to handle both spellings.
        expect(Axon({ model: "auto" }).name).toBe("axon")
    })

    it("carries the declared model", () => {
        expect(Axon({ model: "claude-sonnet-4-6" }).model).toBe("claude-sonnet-4-6")
    })

    it("carries the auto weights that decide the real model", () => {
        const def = Axon({ model: "auto", optimize: { intelligence: 1 }, limit: { cost: 5 } })

        expect(def.optimize).toEqual({ intelligence: 1 })
        expect(def.limit).toEqual({ cost: 5 })
    })

    it("omits what was never configured, rather than stamping undefined", () => {
        // An absent weight must be absent, not present-and-undefined: the
        // resolve payload is built by spreading these, and a literal undefined
        // would send a key the backend then has to defend against.
        const def = Axon({ model: "auto" })

        expect("optimize" in def).toBe(false)
        expect("limit" in def).toBe(false)
    })

    it("omits the model when the account default is wanted", () => {
        expect("model" in Axon()).toBe(false)
    })
})

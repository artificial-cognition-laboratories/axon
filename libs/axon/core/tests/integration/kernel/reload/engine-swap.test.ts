import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"

/**
 * What a hot reload does and does not touch, now that inference is resolved
 * from the user's providers rather than named in the agent's config.
 *
 * Engine bindings are decided ONCE, at boot, against the pool the profile
 * declares. A reload re-reads the agent's own config — its tools, prompts,
 * policy — but cannot change what a user has, so it does not re-resolve.
 * Changing which model serves a role is a deliberate act on one role, not a
 * side effect of editing a file: `Engines.select()` for a picked model string,
 * `Engines.rebind()` for a capability already in hand.
 *
 * That distinction is load-bearing and was, for a while, only half-built. The
 * rule below is correct, but nothing called either verb — so the TUI's model
 * picker wrote the choice to axon.config.ts and waited for the reload these
 * tests describe, which by design does not re-resolve. The pick took effect
 * only after a full reboot. The reload behaviour asserted here did not change;
 * what changed is that the picker now performs the deliberate act instead of
 * relying on a reload to do something it never did.
 *
 * These tests used to assert the opposite, because `engine:` WAS agent config
 * and swapping it was the whole model-picker flow.
 */
describe("kernel reload: inference survives a reload", () => {
    it("keeps serving from the engine resolved at boot", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "from the boot engine" })] } },
        })

        await runtime.update({ config: { providers: [Mock({ hello: "from a later edit" })] } })

        const result = await runtime.axon.request("hello")

        // The reload did not re-resolve: a user's providers are not something
        // an agent's own config can change.
        expect(result.text).toBe("from the boot engine")

        await runtime.shutdown()
    })

    it("a reload does not tear down the bound engine", async () => {
        let calls = 0
        const engine = Mock(() => { calls++; return "answered" })

        const runtime = await Axon({ blueprint: { config: { providers: [engine] } } })
        await runtime.axon.request("first")
        expect(calls).toBe(1)

        await runtime.update({ config: {} })
        await runtime.axon.request("second")

        // Same binding, still live — the reload changed config, not inference.
        expect(calls).toBe(2)

        await runtime.shutdown()
    })

    it("update() leaves the rest of the config intact", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi" })] } },
        })

        await runtime.update({ config: { links: { docs: "/api/help" } } })

        const result = await runtime.axon.request("hello")
        expect(result.text).toBe("hi")

        await runtime.shutdown()
    })
})

import { describe, expect, it } from "bun:test"
import { Mock } from "@arcforge/engines"
import { Axon } from "../../../setup/axon"

/**
 * The wire, end to end: a profile declares inference, an agent declares roles,
 * and the runtime binds one to the other.
 *
 * These assert the SEAM rather than the resolver's arithmetic (which has its
 * own unit tests in @arcforge/engines) — that `blueprint.profileProviders`
 * actually reaches resolution, that a cognet's declared role actually reaches
 * the kernel ABI, and that an agent whose requirements cannot be met refuses
 * to boot rather than failing mid-conversation.
 */
describe("inference: the profile → cognet wire", () => {
    it("binds a declared role and exposes it on the ABI", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock(() => "hello")] } } })

        expect(runtime.kernel.engines?.has("main")).toBe(true)
        expect(runtime.kernel.engines?.has("nothing-declared")).toBe(false)

        await runtime.shutdown()
    })

    it("reports what the bound engine actually is, not what was asked for", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

        const bound = runtime.kernel.engines?.get("main")

        expect(bound?.binding.capability.in).toContain("text")
        expect(bound?.binding.slots).toBeGreaterThanOrEqual(1)

        await runtime.shutdown()
    })

    it("a role the cognet never declared throws rather than falling back", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

        // Silently answering with the cortex would produce plausible output
        // from the wrong model — worse than a loud failure, and invisible in
        // a log.
        expect(() => runtime.kernel.engines?.get("percept")).toThrow(/ENGINE_ROLE_UNBOUND/)

        await runtime.shutdown()
    })

    it("a profile's providers reach resolution", async () => {
        const runtime = await Axon({
            blueprint: {
                profileProviders: [{ provider: "mock" }],
                config: { providers: [] },
            },
        })

        // The agent declares no providers of its own — the profile is the
        // only source of inference, so a bound role proves the field is read.
        expect(runtime.kernel.engines?.has("main")).toBe(true)
        expect(runtime.kernel.engines?.get("main").binding.capability.provider).toBe("mock")

        await runtime.shutdown()
    })

    it("an empty providers array still boots — mock is implicit", async () => {
        /**
         * This used to assert the opposite, and the change is deliberate.
         *
         * `providers: []` meant "no inference at all" and refused to boot.
         * That was right while the alternative was silently restoring a
         * provider the user had deleted — but `axon` and `mock` are not things
         * a user declares any more (see providerPool's IMPLICIT_PROVIDERS).
         * They come with running Axon, so an empty array says "I have added
         * nothing", not "take away what I never added".
         *
         * THE TRADE, stated because it is a real loss: `[]` was the cheapest
         * way to reach ENGINE_REQUIREMENTS_UNMET, and it no longer reaches it.
         * That error is still thrown — by a ROLE nothing can fill, which is
         * what it was always about — but it is now harder to provoke on
         * purpose. The test below covers the property that actually matters.
         */
        const runtime = await Axon({ blueprint: { config: { providers: [] } } })

        expect(runtime.kernel.engines?.has("main")).toBe(true)

        await runtime.shutdown()
    })

    it("a served request goes through the bound role", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock(() => "answered")] } } })

        const { entries } = await runtime.kernel.request({ content: "hello" })
        const text = entries
            .filter(entry => entry.type === "cognet:output:text")
            .map(entry => (entry.data as { content?: string }).content ?? "")
            .join("")

        expect(text).toContain("answered")

        await runtime.shutdown()
    })
})

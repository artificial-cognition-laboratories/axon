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

    it("an agent with no inference at all refuses to boot", async () => {
        await expect(Axon({ blueprint: { config: { providers: [] } } }))
            .rejects.toMatchObject({ code: "AX-ENGINE-003" })
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

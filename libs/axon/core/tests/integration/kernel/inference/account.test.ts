import { describe, expect, it } from "bun:test"
import { KERNEL_ABI_VERSION, type EngineCloud, type CloudModelCatalog } from "@arcforge/types"
import { AxonCloud } from "../../../../../../cloud/src"
import { withIdentity, backendUrl } from "../../../../../../cloud/tests/full/setup"
import { Inference } from "../../../../src"
import { AxonBlueprint } from "../../../../src/platform"

describe("account connections reach runtime resolution", () => {
    it("resolves an explicit provider on a signed-out host without attempting vault discovery", async () => {
        let reads = 0
        const client = AxonCloud({ environmentCredentials: false, reporting: false,
            fetch: Object.assign(async () => { reads++; throw new Error("Signed-out hosts cannot query account connections") }, { preconnect: fetch.preconnect }),
        })
        const catalogue: CloudModelCatalog = { models: [{ id: "fixture", name: "fixture", context: 8192, modality: "text->text", routes: [{ via: "groq", model: "fixture" }] }], failures: [] }
        const cloud: EngineCloud = { user: client.user, registry: { models: { all: async () => catalogue } }, cloud: client.cloud }
        const blueprint = AxonBlueprint({
            config: { providers: [{ provider: "groq", key: "explicit-fixture-key" }] },
            cognet: { name: "fixture", version: "1.0.0", abi: KERNEL_ABI_VERSION, path: "/unused-resolution-only", hash: "fixture",
                engines: { main: { type: "generate", in: ["text"], out: ["text"], context: 4096, primary: true } } },
        })
        const engines = await Inference({ blueprint: blueprint, cloud: cloud })
        expect(engines?.get("main").binding.capability.provider).toBe("groq")
        expect(reads).toBe(0)
    })
    it("binds a fresh host to its account provider without a local provider declaration", async () => {
        await withIdentity("inferenceaccount", async ({ cloud: first, who }) => {
            await first.user.vault.connections.get("zai").connect({ key: "runtime-fixture-key" })
            const second = AxonCloud({ baseUrl: backendUrl(), key: who.apiKey, reporting: false })
            const catalogue: CloudModelCatalog = { models: [{ id: "fixture", name: "fixture", context: 8192, modality: "text->text", routes: [{ via: "zai", model: "fixture" }] }], failures: [] }
            const cloud: EngineCloud = { user: second.user, registry: { models: { all: async () => catalogue } }, cloud: second.cloud }
            const blueprint = AxonBlueprint({
                cognet: { name: "fixture", version: "1.0.0", abi: KERNEL_ABI_VERSION, path: "/unused-resolution-only", hash: "fixture",
                    engines: { main: { type: "generate", in: ["text"], out: ["text"], context: 4096, primary: true } } },
            })
            const engines = await Inference({ blueprint: blueprint, cloud: cloud })
            expect(engines?.get("main").binding.capability.provider).toBe("zai")
            // Explicit machine policy must still restrict account discovery.
            const restricted = await Inference({ blueprint: { ...blueprint, profileProviders: [] }, cloud: cloud })
            expect(restricted?.get("main").binding.capability.provider).toBe("mock")
        })
    })
})

import { AxonCloud } from "../../../src"
import { TEST_USER, scopedName } from "../../setup/user"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()

describe("registry.agents.list", () => {
    it("requires auth — no key at all rejects rather than returning an empty/anonymous list", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.registry.artifacts.of("agent").listOwned()).rejects.toThrow()
    })

    it("an invalid key rejects", async () => {
        const cloud = AxonCloud({ baseUrl, key: "axon_totally_not_a_real_key" })

        await expect(cloud.registry.artifacts.of("agent").listOwned()).rejects.toThrow()
    })

    it("returns the caller's own agents, including one just created", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-registry-list")

        const created = await cloud.registry.artifacts.of("agent").create({ name })
        const list = await cloud.registry.artifacts.of("agent").listOwned()

        expect(list.some(a => a.artifactId === created.id)).toBe(true)
    })

    it("each record has the expected fields", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const list = await cloud.registry.artifacts.of("agent").listOwned()

        expect(list.length).toBeGreaterThan(0)
        const first = list[0]
        expect(typeof first.artifactId).toBe("string")
        expect(typeof first.name).toBe("string")
        expect(typeof first.private).toBe("boolean")
    })
})

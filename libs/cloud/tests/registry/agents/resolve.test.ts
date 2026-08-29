import { AxonCloud } from "../../../src"
import { TEST_USER, scopedName } from "../../setup/user"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()

describe("registry.agents.resolve", () => {
    it("resolves a freshly created agent by the name it was created with", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-registry-resolve")
        const created = await cloud.registry.artifacts.of("agent").create({ name })

        const resolved = await cloud.registry.artifacts.of("agent").handle(name)

        expect(resolved.id).toBe(created.id)
    })

    it("resolving an unknown name rejects rather than returning a null/empty handle", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.registry.artifacts.of("agent").handle(`zzz-definitely-not-real-${crypto.randomUUID()}`)).rejects.toThrow()
    })

    it("resolving by id also works — an agent's own id is a valid handle key", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-registry-resolve-by-id")
        const created = await cloud.registry.artifacts.of("agent").create({ name })

        const resolved = await cloud.registry.artifacts.of("agent").handle(created.id)

        expect(resolved.id).toBe(created.id)
    })

    it("a freshly created agent defaults to private — an anonymous caller cannot resolve it", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-registry-resolve-private")
        await owner.registry.artifacts.of("agent").create({ name })

        const anonymous = anonymousCloud()

        await expect(anonymous.registry.artifacts.of("agent").handle(name)).rejects.toThrow()
    })
})

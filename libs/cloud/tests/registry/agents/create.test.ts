import { AxonCloud } from "../../../src"
import { OTHER_USER, TEST_USER, scopedName } from "../../setup/user"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()

describe("registry.agents.create", () => {
    it("creates a new agent and returns a handle with the assigned id", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-registry-create")

        const created = await cloud.registry.artifacts.of("agent").create({ name })

        expect(typeof created.id).toBe("string")
    })

    it("is idempotent — creating with the same name twice returns the same agentId", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-registry-create-idempotent")

        const first = await cloud.registry.artifacts.of("agent").create({ name })
        const second = await cloud.registry.artifacts.of("agent").create({ name })

        expect(second.id).toBe(first.id)
    })

    it("requires auth — no key rejects rather than creating anonymously", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.registry.artifacts.of("agent").create({ name: scopedName("test-registry-create-noauth") })).rejects.toThrow()
    })

    it("the created agent immediately resolves by its name", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-registry-create-resolve")

        const created = await cloud.registry.artifacts.of("agent").create({ name })
        const resolved = await cloud.registry.artifacts.of("agent").handle(name)

        expect(resolved.id).toBe(created.id)
    })

    it("rejects publishing an agent into an org namespace the caller does not belong to", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const outsider = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const slug = `test-agent-scope-denied-${crypto.randomUUID().slice(0, 8)}`
        const org = await owner.user.orgs.create({ slug })

        try {
            await expect(
                outsider.registry.artifacts.of("agent").create({ name: `@${slug}/forbidden-${crypto.randomUUID().slice(0, 8)}` })
            ).rejects.toThrow(/not a member/)
        } finally {
            await org.delete()
        }
    })
})

import { AxonCloud } from "../../../src"
import { OTHER_USER, TEST_USER, scopedName } from "../../setup/user"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()

describe("registry.modules.create", () => {
    it("creates a new module and returns a handle with the assigned id", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-registry-module-create")

        const created = await cloud.registry.artifacts.of("module").create({ name })

        expect(typeof created.id).toBe("string")
    })

    it("is idempotent — creating with the same name twice returns the same moduleId", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-registry-module-create-idempotent")

        const first = await cloud.registry.artifacts.of("module").create({ name })
        const second = await cloud.registry.artifacts.of("module").create({ name })

        expect(second.id).toBe(first.id)
    })

    it("creates a scoped module in an org the caller belongs to", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = `test-module-scope-${crypto.randomUUID().slice(0, 8)}`
        const name = `module-${crypto.randomUUID().slice(0, 8)}`
        const org = await cloud.user.orgs.create({ slug })

        try {
            const module = await cloud.registry.artifacts.of("module").create({ name: `@${slug}/${name}` })
            const record = await module.get()

            // `name` IS the full scoped identity — the registry stores it
            // exactly as published, and orgSlug is the authorization fact
            // derived from it, never a second half of the name.
            expect(record.name).toBe(`@${slug}/${name}`)
            expect(record.orgSlug).toBe(slug)
        } finally {
            await org.delete()
        }
    })

    it("rejects publishing into an org namespace the caller does not belong to", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const outsider = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const slug = `test-module-scope-denied-${crypto.randomUUID().slice(0, 8)}`
        const org = await owner.user.orgs.create({ slug })

        try {
            await expect(
                outsider.registry.artifacts.of("module").create({ name: `@${slug}/forbidden-${crypto.randomUUID().slice(0, 8)}` })
            ).rejects.toThrow(/not a member/)
        } finally {
            await org.delete()
        }
    })

    it("rejects another user's personal namespace", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await expect(
            cloud.registry.artifacts.of("module").create({ name: `@otheruser/forbidden-${crypto.randomUUID().slice(0, 8)}` })
        ).rejects.toThrow(/cannot publish/)
    })

    it("requires auth — no key rejects rather than creating anonymously", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.registry.artifacts.of("module").create({ name: scopedName("test-registry-module-noauth") })).rejects.toThrow()
    })
})

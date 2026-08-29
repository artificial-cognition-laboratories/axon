import { AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

function disposableSlug(): string {
    return `test-org-create-${crypto.randomUUID().slice(0, 8)}`
}

describe("orgs.create", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.orgs.create({ slug: disposableSlug() })).rejects.toThrow()
    })

    it("creates an org and returns a scoped handle for it", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()

        const org = await cloud.user.orgs.create({ slug })

        expect(org.slug).toBe(slug)
        await org.delete()
    })

    it("the caller becomes owner of the org they created", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()

        const org = await cloud.user.orgs.create({ slug })
        const memberships = await cloud.user.orgs.list()

        expect(memberships.find(m => m.slug === slug)?.role).toBe("owner")
        await org.delete()
    })

    it("persists displayName and description when given", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()

        const org = await cloud.user.orgs.create({ slug, displayName: "Test Display Name", description: "a test org" })
        const profile = await org.get()

        expect(profile.displayName).toBe("Test Display Name")
        expect(profile.description).toBe("a test org")
        await org.delete()
    })

    it("rejects a slug that's already taken", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        try {
            await expect(cloud.user.orgs.create({ slug })).rejects.toThrow()
        } finally {
            await org.delete()
        }
    })
})

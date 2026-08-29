import { AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

describe("orgs.list", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.orgs.list()).rejects.toThrow()
    })

    it("returns the caller's real memberships with the expected shape", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const memberships = await cloud.user.orgs.list()

        expect(memberships.length).toBeGreaterThan(0)
        const first = memberships[0]
        expect(typeof first.id).toBe("string")
        expect(typeof first.slug).toBe("string")
        expect(["owner", "admin", "member"]).toContain(first.role)
        expect(typeof first.joinedAt).toBe("string")
    })

    it("includes the known seeded axon membership", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const memberships = await cloud.user.orgs.list()

        expect(memberships.some(m => m.slug === "axon")).toBe(true)
    })

    it("reflects a fresh org immediately after creation", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = `test-org-list-${crypto.randomUUID().slice(0, 8)}`
        const org = await cloud.user.orgs.create({ slug })

        const memberships = await cloud.user.orgs.list()

        expect(memberships.some(m => m.slug === slug)).toBe(true)
        await org.delete()
    })

    it("does not include an org after it's been deleted", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = `test-org-list-deleted-${crypto.randomUUID().slice(0, 8)}`
        const org = await cloud.user.orgs.create({ slug })
        await org.delete()

        const memberships = await cloud.user.orgs.list()

        expect(memberships.some(m => m.slug === slug)).toBe(false)
    })

    it("an invalid key rejects rather than returning someone else's memberships", async () => {
        const cloud = AxonCloud({ baseUrl, key: "axon_totally_not_a_real_key" })

        await expect(cloud.user.orgs.list()).rejects.toThrow()
    })
})

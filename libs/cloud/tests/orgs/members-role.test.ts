import { AxonCloud } from "../../src"
import { TEST_USER, OTHER_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

function disposableSlug(): string {
    return `test-org-members-role-${crypto.randomUUID().slice(0, 8)}`
}

describe("org.members.setRole", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.orgs.org(disposableSlug()).members.setRole(TEST_USER.id, "admin")).rejects.toThrow()
    })

    it("changes a member's role", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })
        await org.members.add({ username: "otheruser", role: "member" })

        await org.members.setRole(OTHER_USER.id, "admin")
        const members = await org.members.list()

        expect(members.find(m => m.userId === OTHER_USER.id)?.role).toBe("admin")

        await org.delete()
    })

    it("rejects an unknown target user", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        await expect(org.members.setRole(crypto.randomUUID(), "admin")).rejects.toThrow()

        await org.delete()
    })

    it("a plain member cannot change roles — owner/admin only", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })
        await org.members.add({ username: "otheruser", role: "member" })

        const memberClient = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })

        try {
            await expect(
                memberClient.user.orgs.org(slug).members.setRole(TEST_USER.id, "member")
            ).rejects.toThrow()
        } finally {
            await org.delete()
        }
    })

    describe("last-owner protection", () => {
        it("blocks demoting the org's only owner", async () => {
            const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
            const slug = disposableSlug()
            const org = await cloud.user.orgs.create({ slug })

            await expect(org.members.setRole(TEST_USER.id, "member")).rejects.toThrow(/only owner/)

            await org.delete()
        })

        it("allows demoting an owner once a second owner exists", async () => {
            const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
            const slug = disposableSlug()
            const org = await cloud.user.orgs.create({ slug })
            await org.members.add({ username: "otheruser", role: "owner" })

            await org.members.setRole(TEST_USER.id, "member")
            const members = await org.members.list()
            expect(members.find(m => m.userId === TEST_USER.id)?.role).toBe("member")

            // restore TEST_USER as owner so it (not OTHER_USER) can clean up
            const otherClient = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
            await otherClient.user.orgs.org(slug).members.setRole(TEST_USER.id, "owner")
            await org.delete()
        })
    })
})

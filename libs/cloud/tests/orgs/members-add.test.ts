import { AxonCloud } from "../../src"
import { TEST_USER, OTHER_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

function disposableSlug(): string {
    return `test-org-members-add-${crypto.randomUUID().slice(0, 8)}`
}

describe("org.members.add", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.orgs.org(disposableSlug()).members.add({ username: "otheruser" })).rejects.toThrow()
    })

    it("adds a real user by username, defaulting to the member role", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        const added = await org.members.add({ username: "otheruser" })

        expect(added.userId).toBe(OTHER_USER.id)
        expect(added.username).toBe("otheruser")
        expect(added.role).toBe("member")

        await org.delete()
    })

    it("accepts an explicit role", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        const added = await org.members.add({ username: "otheruser", role: "admin" })

        expect(added.role).toBe("admin")

        await org.delete()
    })

    it("rejects a username that doesn't exist", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        await expect(org.members.add({ username: `nonexistent-${crypto.randomUUID()}` })).rejects.toThrow()

        await org.delete()
    })

    it("a plain member cannot add other members — owner/admin only", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })
        await org.members.add({ username: "otheruser", role: "member" })

        const memberClient = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })

        try {
            await expect(
                memberClient.user.orgs.org(slug).members.add({ username: "otheruser" })
            ).rejects.toThrow()
        } finally {
            await org.delete()
        }
    })
})

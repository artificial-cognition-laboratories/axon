import { AxonCloud } from "../../src"
import { TEST_USER, OTHER_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

function disposableSlug(): string {
    return `test-org-members-list-${crypto.randomUUID().slice(0, 8)}`
}

describe("org.members.list", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.orgs.org(disposableSlug()).members.list()).rejects.toThrow()
    })

    it("a fresh org's roster contains only the creating owner", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        const members = await org.members.list()

        expect(members.length).toBe(1)
        expect(members[0].userId).toBe(TEST_USER.id)
        expect(members[0].role).toBe("owner")

        await org.delete()
    })

    it("reflects an added member immediately", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        await org.members.add({ username: "otheruser" })
        const members = await org.members.list()

        expect(members.some(m => m.userId === OTHER_USER.id)).toBe(true)
        expect(members.length).toBe(2)

        await org.delete()
    })

    it("each member has the expected shape", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        const members = await org.members.list()
        const first = members[0]

        expect(typeof first.userId).toBe("string")
        expect(typeof first.username).toBe("string")
        expect(["owner", "admin", "member"]).toContain(first.role)
        expect(typeof first.joinedAt).toBe("string")

        await org.delete()
    })

    it("a member (not just the owner) can list the roster", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })
        await org.members.add({ username: "otheruser" })

        const memberClient = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const members = await memberClient.user.orgs.org(slug).members.list()

        expect(members.length).toBe(2)

        await org.delete()
    })
})

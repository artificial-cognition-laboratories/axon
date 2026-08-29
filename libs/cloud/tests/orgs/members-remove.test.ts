import { AxonCloud } from "../../src"
import { TEST_USER, OTHER_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

function disposableSlug(): string {
    return `test-org-members-remove-${crypto.randomUUID().slice(0, 8)}`
}

describe("org.members.remove", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.orgs.org(disposableSlug()).members.remove(TEST_USER.id)).rejects.toThrow()
    })

    it("removes a member from the roster", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })
        await org.members.add({ username: "otheruser" })

        await org.members.remove(OTHER_USER.id)
        const members = await org.members.list()

        expect(members.some(m => m.userId === OTHER_USER.id)).toBe(false)

        await org.delete()
    })

    it("rejects removing someone who isn't a member", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        await expect(org.members.remove(OTHER_USER.id)).rejects.toThrow()

        await org.delete()
    })

    it("a member can remove themselves (self-removal) without owner/admin role", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })
        await org.members.add({ username: "otheruser", role: "member" })

        const memberClient = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        await memberClient.user.orgs.org(slug).members.remove(OTHER_USER.id)

        const members = await org.members.list()
        expect(members.some(m => m.userId === OTHER_USER.id)).toBe(false)

        await org.delete()
    })

    it("a plain member cannot remove someone else — owner/admin only", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })
        await org.members.add({ username: "otheruser", role: "member" })

        const memberClient = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })

        try {
            await expect(memberClient.user.orgs.org(slug).members.remove(TEST_USER.id)).rejects.toThrow()
        } finally {
            await org.delete()
        }
    })

    describe("last-owner protection", () => {
        it("blocks removing the org's only owner", async () => {
            const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
            const slug = disposableSlug()
            const org = await cloud.user.orgs.create({ slug })

            await expect(org.members.remove(TEST_USER.id)).rejects.toThrow(/only owner/)

            await org.delete()
        })

        it("blocks the sole owner from removing themselves too — self-removal isn't exempt", async () => {
            const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
            const slug = disposableSlug()
            const org = await cloud.user.orgs.create({ slug })

            await expect(org.members.remove(TEST_USER.id)).rejects.toThrow()

            await org.delete()
        })

        it("allows removing an owner once a second owner exists", async () => {
            const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
            const slug = disposableSlug()
            const org = await cloud.user.orgs.create({ slug })
            await org.members.add({ username: "otheruser", role: "owner" })

            await org.members.remove(TEST_USER.id)

            // TEST_USER is no longer a member and can't list() anymore —
            // check via OTHER_USER, the now-sole owner, who also cleans up
            const otherClient = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
            const members = await otherClient.user.orgs.org(slug).members.list()
            expect(members.some(m => m.userId === TEST_USER.id)).toBe(false)

            await otherClient.user.orgs.org(slug).delete()
        })
    })
})

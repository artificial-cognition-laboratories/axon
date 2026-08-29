import { AxonCloud } from "../../src"
import { TEST_USER, OTHER_USER } from "../setup/user"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()

function disposableSlug(): string {
    return `test-org-perm-${crypto.randomUUID().slice(0, 8)}`
}

describe("org permissions: non-member boundary", () => {
    it("an authenticated non-member cannot update someone else's org", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })

        const outsider = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })

        try {
            await expect(outsider.user.orgs.org(slug).update({ displayName: "hijacked" })).rejects.toThrow()
        } finally {
            await org.delete()
        }
    })

    it("an authenticated non-member cannot delete someone else's org", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })

        const outsider = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })

        try {
            await expect(outsider.user.orgs.org(slug).delete()).rejects.toThrow()
        } finally {
            await org.delete()
        }
    })

    it("an authenticated non-member cannot add members to someone else's org", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })

        const outsider = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })

        try {
            await expect(outsider.user.orgs.org(slug).members.add({ username: "someone" })).rejects.toThrow()
        } finally {
            await org.delete()
        }
    })

    it("a non-member does not see the org in their own list()", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })

        const outsider = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const memberships = await outsider.user.orgs.list()

        expect(memberships.some(m => m.slug === slug)).toBe(false)

        await org.delete()
    })

    it("the org's public profile is still readable by a non-member — get() has no membership gate", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await owner.user.orgs.create({ slug })

        const outsider = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })

        try {
            const profile = await outsider.user.orgs.org(slug).get()
            expect(profile.slug).toBe(slug)
        } finally {
            await org.delete()
        }
    })
})

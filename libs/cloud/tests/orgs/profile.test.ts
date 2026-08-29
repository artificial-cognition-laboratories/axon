import { AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

function disposableSlug(): string {
    return `test-org-profile-${crypto.randomUUID().slice(0, 8)}`
}

describe("org.get", () => {
    it("works logged-out — public profile needs no auth", async () => {
        const cloud = anonymousCloud()

        const profile = await cloud.user.orgs.org("axon").get()

        expect(profile.slug).toBe("axon")
    })

    it("returns the expected shape, including a real memberCount", async () => {
        const cloud = anonymousCloud()

        const profile = await cloud.user.orgs.org("axon").get()

        expect(typeof profile.id).toBe("string")
        expect(typeof profile.createdAt).toBe("string")
        expect(profile.memberCount).toBeGreaterThan(0)
    })

    it("rejects an unknown slug rather than returning null/empty", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.orgs.org(`nonexistent-${crypto.randomUUID()}`).get()).rejects.toThrow()
    })
})

describe("org.update", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        // Targets a disposable slug, never the real `axon` org. The assertion is
        // about the 401 and gains nothing from naming a real org — but if auth
        // ever regresses, pointing this at shared seed data turns a red test
        // into corrupted state every other test in this suite reads. It did
        // exactly that once, when anonymousCloud() still adopted AXON_API_KEY
        // from the environment and the test user was an admin of `axon`.
        await expect(cloud.user.orgs.org(disposableSlug()).update({ displayName: "hacked" })).rejects.toThrow()
    })

    it("the owner can update their own disposable org's fields", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        await org.update({ displayName: "Updated Name", website: "https://example.com" })
        const profile = await org.get()

        expect(profile.displayName).toBe("Updated Name")
        expect(profile.website).toBe("https://example.com")

        await org.delete()
    })

    it("update() only changes the fields given, leaving others untouched", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug, description: "original description" })

        await org.update({ displayName: "New Display Name" })
        const profile = await org.get()

        expect(profile.displayName).toBe("New Display Name")
        expect(profile.description).toBe("original description")

        await org.delete()
    })
})

describe("org.delete", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        // Disposable slug — see the note on org.update's auth test.
        await expect(cloud.user.orgs.org(disposableSlug()).delete()).rejects.toThrow()
    })

    it("the owner can delete their own disposable org — it no longer resolves afterward", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })

        await org.delete()

        await expect(cloud.user.orgs.org(slug).get()).rejects.toThrow()
    })

    it("deleting an already-deleted org rejects rather than silently succeeding twice", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const slug = disposableSlug()
        const org = await cloud.user.orgs.create({ slug })
        await org.delete()

        await expect(org.delete()).rejects.toThrow()
    })
})

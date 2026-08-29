import { AxonCloud } from "../../../src"
import { OTHER_USER, TEST_USER, scopedName } from "../../setup/user"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()


describe("agent.stats", () => {
    it("returns real zeroed stats for a freshly created agent", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const agent = await cloud.registry.artifacts.of("agent").create({ name: scopedName("test-registry-social") })

        const stats = await agent.stats()

        expect(stats.installsTotal).toBe(0)
        expect(stats.starsTotal).toBe(0)
        // No activeDeployments here: it was served only by the retired
        // /api/agents/:id/stats route and read by nothing. The running count
        // is account-wide and lives on user.overview().
        expect(stats.starredByMe).toBe(false)
        expect(Array.isArray(stats.daily)).toBe(true)
    })

    it("does not require auth — an anonymous caller can read public stats", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const anon = anonymousCloud()
        const created = await owner.registry.artifacts.of("agent").create({ name: scopedName("test-registry-social") })
        // Artifacts are created PRIVATE (schema default), and a private agent's
        // stats are not public — the visibility flip is what makes this test
        // about the anonymous read it claims to be. Without it, it asserted
        // that anyone could read a private agent's install and star counts,
        // which is the leak the route was fixed for.
        await owner.registry.artifacts.artifact(created.id).update({ private: false })

        const stats = await anon.registry.artifacts.artifact(created.id).stats()

        expect(stats.starredByMe).toBe(false)
    })

    it("rejects an unknown agent id", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await expect(cloud.registry.artifacts.artifact(crypto.randomUUID()).stats()).rejects.toThrow()
    })

    /**
     * Regression: these three routes served PRIVATE agents to anyone.
     * `stats`, `versions`, and `versions/:v/download` each resolved the
     * artifact and never checked visibility, while their module and artifact
     * siblings did — so the whole class was invisible in review. The download
     * route is the sharp one: in production it returns a signed GCS URL to the
     * source tarball, readable with no credential at all.
     */
    it("a private agent is invisible to an anonymous caller, on every read route", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const anon = anonymousCloud()
        // Created private by default — deliberately not flipped.
        const created = await owner.registry.artifacts.of("agent").create({ name: scopedName("test-registry-private") })

        await expect(anon.registry.artifacts.artifact(created.id).stats()).rejects.toThrow()
        await expect(anon.registry.artifacts.artifact(created.id).versions()).rejects.toThrow()
        await expect(anon.registry.artifacts.artifact(created.id).get()).rejects.toThrow()

        // The owner still reaches all of it.
        expect((await owner.registry.artifacts.artifact(created.id).get()).private).toBe(true)
    })

    it("a private agent is invisible to a DIFFERENT authenticated user", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const other = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const created = await owner.registry.artifacts.of("agent").create({ name: scopedName("test-registry-private") })

        // 404, not 403 — confirming existence is itself a leak.
        await expect(other.registry.artifacts.artifact(created.id).stats()).rejects.toThrow()
        await expect(other.registry.artifacts.artifact(created.id).versions()).rejects.toThrow()
        await expect(other.registry.artifacts.artifact(created.id).get()).rejects.toThrow()
    })
})

describe("agent.star / unstar", () => {
    it("requires auth", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const anon = anonymousCloud()
        const created = await owner.registry.artifacts.of("agent").create({ name: scopedName("test-registry-social") })

        await expect(anon.registry.artifacts.artifact(created.id).star()).rejects.toThrow()
    })

    it("star() increments starsTotal and sets starredByMe for the caller", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const agent = await cloud.registry.artifacts.of("agent").create({ name: scopedName("test-registry-social") })

        await agent.star()
        const stats = await agent.stats()

        expect(stats.starsTotal).toBe(1)
        expect(stats.starredByMe).toBe(true)
    })

    it("unstar() reverts the count and starredByMe", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const agent = await cloud.registry.artifacts.of("agent").create({ name: scopedName("test-registry-social") })

        await agent.star()
        await agent.unstar()
        const stats = await agent.stats()

        expect(stats.starsTotal).toBe(0)
        expect(stats.starredByMe).toBe(false)
    })

    it("starring is per-caller — one user's star doesn't mark it starred for another", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const other = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const created = await owner.registry.artifacts.of("agent").create({ name: scopedName("test-registry-social") })
        // Public, so the OTHER user may read it at all — see the note above.
        // This test is about star attribution, not visibility.
        await owner.registry.artifacts.artifact(created.id).update({ private: false })

        await owner.registry.artifacts.artifact(created.id).star()
        const asOther = await other.registry.artifacts.artifact(created.id).stats()

        expect(asOther.starredByMe).toBe(false)
        expect(asOther.starsTotal).toBe(1)

        await owner.registry.artifacts.artifact(created.id).unstar()
    })
})

describe("agent.setVisibility", () => {
    it("requires auth", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const anon = anonymousCloud()
        const created = await owner.registry.artifacts.of("agent").create({ name: scopedName("test-registry-social") })

        await expect(anon.registry.artifacts.artifact(created.id).update({ private: false })).rejects.toThrow()
    })

    it("rejects a non-owner", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const created = await owner.registry.artifacts.of("agent").create({ name: scopedName("test-registry-social") })

        await expect(intruder.registry.artifacts.artifact(created.id).update({ private: true })).rejects.toThrow()
    })

    it("a newly created agent is private by default, and setVisibility(true) makes it public", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const agent = await cloud.registry.artifacts.of("agent").create({ name: scopedName("test-registry-social") })

        const initial = await agent.get()
        expect(initial.private).toBe(true)

        await agent.update({ private: false })
        const afterPublic = await agent.get()
        expect(afterPublic.private).toBe(false)

        await agent.update({ private: true })
        const afterPrivate = await agent.get()
        expect(afterPrivate.private).toBe(true)
    })
})

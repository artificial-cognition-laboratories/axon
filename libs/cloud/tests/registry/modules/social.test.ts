import { AxonCloud } from "../../../src"
import { OTHER_USER, TEST_USER, scopedName } from "../../setup/user"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()


describe("module.stats", () => {
    it("returns real zeroed stats for a freshly created module", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const module_ = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-social") })

        const stats = await module_.stats()

        expect(stats.installsTotal).toBe(0)
        expect(stats.starsTotal).toBe(0)
        expect(stats.starredByMe).toBe(false)
        expect(Array.isArray(stats.daily)).toBe(true)
    })

    it("rejects an unknown module id", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await expect(cloud.registry.artifacts.artifact(crypto.randomUUID()).stats()).rejects.toThrow()
    })
})

describe("module.star / unstar", () => {
    it("requires auth", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const anon = anonymousCloud()
        const created = await owner.registry.artifacts.of("module").create({ name: scopedName("test-module-social") })

        await expect(anon.registry.artifacts.artifact(created.id).star()).rejects.toThrow()
    })

    it("star() increments starsTotal and sets starredByMe for the caller", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const module_ = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-social") })

        await module_.star()
        const stats = await module_.stats()

        expect(stats.starsTotal).toBe(1)
        expect(stats.starredByMe).toBe(true)
    })

    it("unstar() reverts the count and starredByMe", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const module_ = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-social") })

        await module_.star()
        await module_.unstar()
        const stats = await module_.stats()

        expect(stats.starsTotal).toBe(0)
        expect(stats.starredByMe).toBe(false)
    })

    it("starring is per-caller", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const other = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const created = await owner.registry.artifacts.of("module").create({ name: scopedName("test-module-social") })
        await created.update({ private: false })

        await owner.registry.artifacts.artifact(created.id).star()
        const asOther = await other.registry.artifacts.artifact(created.id).stats()

        expect(asOther.starredByMe).toBe(false)
        expect(asOther.starsTotal).toBe(1)

        await owner.registry.artifacts.artifact(created.id).unstar()
    })
})

describe("module.update", () => {
    it("requires auth", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const anon = anonymousCloud()
        const created = await owner.registry.artifacts.of("module").create({ name: scopedName("test-module-social") })

        await expect(anon.registry.artifacts.artifact(created.id).update({ private: false })).rejects.toThrow()
    })

    it("rejects a non-owner", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const created = await owner.registry.artifacts.of("module").create({ name: scopedName("test-module-social") })

        await expect(intruder.registry.artifacts.artifact(created.id).update({ private: false })).rejects.toThrow()
    })

    it("a newly created module is private by default; update can flip visibility and description", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const module_ = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-social") })

        const initial = await module_.get()
        expect(initial.private).toBe(true)

        await module_.update({ private: false, description: "updated description" })
        const updated = await module_.get()

        expect(updated.private).toBe(false)
        expect(updated.description).toBe("updated description")
    })
})

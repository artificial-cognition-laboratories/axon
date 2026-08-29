import { AxonCloud } from "../../../src"
import { OTHER_USER, TEST_USER, scopedName } from "../../setup/user"
import { fixtureModuleBundle } from "./fixtures"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()

describe("registry.modules.resolve", () => {
    it("resolving an unknown name rejects rather than returning a null/empty result", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.registry.modules.resolve(`zzz-definitely-not-real-${crypto.randomUUID()}`)).rejects.toThrow()
    })

    it("a module with no published version rejects rather than resolving to nothing", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("test-module-resolve-unpublished")
        await cloud.registry.artifacts.of("module").create({ name })

        // registration alone (no publish()) is not enough — resolve() needs
        // an actual published version, unlike agents which resolve on creation
        await expect(cloud.registry.modules.resolve(name)).rejects.toThrow()
    })

    it("keeps every private-module read path owner-only", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const outsider = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const anonymous = anonymousCloud()
        const name = scopedName("test-module-resolve-private")
        const target = await owner.registry.artifacts.of("module").create({ name, private: true })
        const bundle = await fixtureModuleBundle({ version: "0.0.1" })

        try {
            await target.publish({ path: bundle.path })

            // The install path keeps its own payload, keyed on moduleId.
            expect((await owner.registry.modules.resolve(name)).moduleId).toBe(target.id)
            expect((await owner.registry.artifacts.of("module").resolve(name)).artifactId).toBe(target.id)
            expect(await target.downloadUrl("0.0.1")).toContain("http")

            await expect(anonymous.registry.modules.resolve(name)).rejects.toThrow()
            await expect(outsider.registry.modules.resolve(name)).rejects.toThrow()
            await expect(anonymous.registry.artifacts.of("module").resolve(name)).rejects.toThrow()
            await expect(outsider.registry.artifacts.of("module").resolve(name)).rejects.toThrow()
            await expect(anonymous.registry.artifacts.artifact(target.id).get()).rejects.toThrow()
            await expect(outsider.registry.artifacts.artifact(target.id).get()).rejects.toThrow()
            await expect(anonymous.registry.artifacts.artifact(target.id).versions()).rejects.toThrow()
            await expect(outsider.registry.artifacts.artifact(target.id).versions()).rejects.toThrow()
            await expect(anonymous.registry.artifacts.artifact(target.id).stats()).rejects.toThrow()
            await expect(outsider.registry.artifacts.artifact(target.id).stats()).rejects.toThrow()
            await expect(outsider.registry.artifacts.artifact(target.id).star()).rejects.toThrow()
            await expect(anonymous.registry.artifacts.artifact(target.id).downloadUrl("0.0.1")).rejects.toThrow()
            await expect(outsider.registry.artifacts.artifact(target.id).downloadUrl("0.0.1")).rejects.toThrow()
        } finally {
            await bundle.cleanup()
        }
    })
})

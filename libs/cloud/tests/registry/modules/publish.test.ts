import { AxonCloud } from "../../../src"
import { OTHER_USER, TEST_USER, scopedName } from "../../setup/user"
import { fixtureModuleBundle } from "./fixtures"
import { backendUrl, anonymousCloud } from "../../setup/staging"

const baseUrl = backendUrl()


describe("module.publish", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()
        const bundle = await fixtureModuleBundle({ version: "0.0.1" })

        try {
            await expect(cloud.registry.artifacts.artifact(crypto.randomUUID()).publish({ path: bundle.path })).rejects.toThrow()
        } finally {
            await bundle.cleanup()
        }
    })

    it("rejects publishing to a module the caller doesn't own", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const target = await owner.registry.artifacts.of("module").create({ name: scopedName("test-module-publish") })
        const bundle = await fixtureModuleBundle({ version: "0.0.1" })

        try {
            await expect(intruder.registry.artifacts.artifact(target.id).publish({ path: bundle.path })).rejects.toThrow()
        } finally {
            await bundle.cleanup()
        }
    })

    it("publishes using the version from package.json", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-publish") })
        const bundle = await fixtureModuleBundle({ version: "0.0.1" })

        try {
            const result = await target.publish({ path: bundle.path })
            expect(result.version).toBe("0.0.1")
        } finally {
            await bundle.cleanup()
        }
    })

    it("an explicit version overrides package.json's", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-publish") })
        const bundle = await fixtureModuleBundle({ version: "0.0.1" })

        try {
            const result = await target.publish({ path: bundle.path, version: "9.9.9" })
            expect(result.version).toBe("9.9.9")
        } finally {
            await bundle.cleanup()
        }
    })

    it("rejects re-publishing the same version twice", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-publish") })
        const bundle = await fixtureModuleBundle({ version: "0.0.1" })

        try {
            await target.publish({ path: bundle.path })
            await expect(target.publish({ path: bundle.path })).rejects.toThrow()
        } finally {
            await bundle.cleanup()
        }
    })

    it("versions() reflects a newly published version", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-publish") })
        const bundle = await fixtureModuleBundle({ version: "0.0.1" })

        try {
            await target.publish({ path: bundle.path })
            const versions = await target.versions()

            expect(versions.find(v => v.version === "0.0.1")).toBeDefined()
        } finally {
            await bundle.cleanup()
        }
    })
})

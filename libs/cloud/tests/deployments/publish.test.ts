import { AxonCloud } from "../../src"
import { TEST_USER, OTHER_USER, scopedName } from "../setup/user"
import { fixtureBundle } from "./fixtures"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()


describe("agent.publish", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const agent = cloud.registry.artifacts.artifact(crypto.randomUUID())
            await expect(agent.publish({ path: bundle.path })).rejects.toThrow()
        } finally {
            await bundle.cleanup()
        }
    })

    it("rejects publishing to an agent the caller doesn't own", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const target = await owner.registry.artifacts.of("agent").create({ name: scopedName() })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const agent = intruder.registry.artifacts.artifact(target.id)
            await expect(agent.publish({ path: bundle.path })).rejects.toThrow()
        } finally {
            await bundle.cleanup()
        }
    })

    it("publishes a version and records it against the agent", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("agent").create({ name: scopedName() })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const result = await target.publish({ path: bundle.path })
            expect(result.version).toBe("0.0.1")

            // The publish response used to echo the agent id and a timestamp.
            // The artifact route returns the version, so what the publish
            // actually DID is asserted where it is durable — on the row.
            const [version] = await target.versions()
            expect(version?.version).toBe("0.0.1")
            expect(Number.isNaN(Date.parse(version!.publishedAt))).toBe(false)
            expect((await target.get()).latestVersion).toBe("0.0.1")
        } finally {
            await bundle.cleanup()
        }
    })

    it("never exposes the agent runtime key in the publish response", async () => {
        // The key is minted server-side on first publish, but the plaintext is
        // deliberately not returned — a secret in the response is a leak risk
        // (it has ended up on screen recordings). Users manage it in the
        // dashboard instead.
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("agent").create({ name: scopedName() })
        const first = await fixtureBundle({ version: "0.0.1" })

        try {
            const result = await target.publish({ path: first.path })
            expect("apiKey" in result).toBe(false)
            expect(result.version).toBeTruthy()
        } finally {
            await first.cleanup()
        }
    })

    it("rejects re-publishing the same version twice", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("agent").create({ name: scopedName() })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            await target.publish({ path: bundle.path })
            await expect(target.publish({ path: bundle.path })).rejects.toThrow()
        } finally {
            await bundle.cleanup()
        }
    })

    it("versions() reflects a newly published version", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("agent").create({ name: scopedName() })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            await target.publish({ path: bundle.path })
            const versions = await target.versions()

            expect(versions.find(v => v.version === "0.0.1")).toBeDefined()
        } finally {
            await bundle.cleanup()
        }
    })
})

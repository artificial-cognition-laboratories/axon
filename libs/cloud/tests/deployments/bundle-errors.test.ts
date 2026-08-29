import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AxonCloud } from "../../src"
import { TEST_USER, scopedName } from "../setup/user"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()


describe("agent.publish: bad bundle paths fail before any upload", () => {
    it("rejects a path that doesn't exist", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("agent").create({ name: scopedName("test-bundle-errors") })

        await expect(target.publish({ path: `/tmp/axon-does-not-exist-${crypto.randomUUID()}` })).rejects.toThrow(/does not exist/)
    })

    it("rejects a bundle directory with no source.tar.gz", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("agent").create({ name: scopedName("test-bundle-errors") })
        const dir = await mkdtemp(join(tmpdir(), "axon-bundle-error-"))

        try {
            await writeFile(join(dir, "image.json"), JSON.stringify({ version: "0.0.1" }))
            await expect(target.publish({ path: dir })).rejects.toThrow(/no source\.tar\.gz/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("rejects a bundle directory with no image.json", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("agent").create({ name: scopedName("test-bundle-errors") })
        const dir = await mkdtemp(join(tmpdir(), "axon-bundle-error-"))

        try {
            // package.json present, so the manifest check passes and this
            // isolates the agent-only image.json requirement.
            await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.0.1" }))
            await writeFile(join(dir, "source.tar.gz"), Buffer.from("not a real tarball"))
            await expect(target.publish({ path: dir })).rejects.toThrow(/no image\.json/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("rejects a bundle directory with no package.json", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("agent").create({ name: scopedName("test-bundle-errors") })
        const dir = await mkdtemp(join(tmpdir(), "axon-bundle-error-"))

        try {
            await writeFile(join(dir, "image.json"), JSON.stringify({ version: "0.0.1" }))
            await writeFile(join(dir, "source.tar.gz"), Buffer.from("not a real tarball"))
            await expect(target.publish({ path: dir })).rejects.toThrow(/no package\.json/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("rejects a bare file path that isn't a .tar.gz", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("agent").create({ name: scopedName("test-bundle-errors") })
        const dir = await mkdtemp(join(tmpdir(), "axon-bundle-error-"))
        const badFile = join(dir, "not-a-tarball.txt")

        try {
            await writeFile(badFile, "irrelevant")
            await expect(target.publish({ path: badFile })).rejects.toThrow(/expected a bundle directory or a \.tar\.gz file/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

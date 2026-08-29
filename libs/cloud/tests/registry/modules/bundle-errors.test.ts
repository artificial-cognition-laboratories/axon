import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AxonCloud } from "../../../src"
import { TEST_USER, scopedName } from "../../setup/user"
import { backendUrl } from "../../setup/staging"

const baseUrl = backendUrl()


describe("module.publish: bad bundle paths fail before any upload", () => {
    it("rejects a path that doesn't exist", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-bundle-errors") })

        await expect(target.publish({ path: `/tmp/axon-module-does-not-exist-${crypto.randomUUID()}` })).rejects.toThrow(/does not exist/)
    })

    it("rejects a bundle directory with no source.tar.gz", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-bundle-errors") })
        const dir = await mkdtemp(join(tmpdir(), "axon-module-bundle-error-"))

        try {
            await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.1" }))
            await expect(target.publish({ path: dir })).rejects.toThrow(/no source\.tar\.gz/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("rejects a bundle directory with no package.json", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-bundle-errors") })
        const dir = await mkdtemp(join(tmpdir(), "axon-module-bundle-error-"))

        try {
            await writeFile(join(dir, "source.tar.gz"), Buffer.from("not a real tarball"))
            await expect(target.publish({ path: dir })).rejects.toThrow(/no package\.json/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("rejects a bare file path that isn't a .tar.gz", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-bundle-errors") })
        const dir = await mkdtemp(join(tmpdir(), "axon-module-bundle-error-"))
        const badFile = join(dir, "not-a-tarball.txt")

        try {
            await writeFile(badFile, "irrelevant")
            await expect(target.publish({ path: badFile })).rejects.toThrow(/expected a bundle directory or a \.tar\.gz file/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("rejects a package.json with no version and none passed explicitly", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const target = await cloud.registry.artifacts.of("module").create({ name: scopedName("test-module-bundle-errors") })
        const dir = await mkdtemp(join(tmpdir(), "axon-module-bundle-error-"))

        try {
            await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }))
            await writeFile(join(dir, "source.tar.gz"), Buffer.from("not a real tarball"))
            await expect(target.publish({ path: dir })).rejects.toThrow(/no version/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

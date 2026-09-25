import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Registry } from "@arcforge/platform/services/registry"
import { describe, it, expect } from "bun:test"

async function archive(root: string): Promise<ArrayBuffer> {
    const source = join(root, "source")
    await mkdir(source)
    await writeFile(join(source, "module.config.ts"), "export default defineModule({})\n")
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "@axon/arxiv", version: "4.2.0", private: false }, null, 2))
    const out = join(root, "source.tar.gz")
    await Bun.$`tar -czf ${out} module.config.ts package.json`.cwd(source).quiet()
    return (await Bun.file(out).arrayBuffer())
}

describe("registry source retrieval", () => {

    it("clones one immutable module artifact without a repository", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-clone-"))
        try {
            const body = await archive(root)
            const download = async () => body
            const registry = Registry({
                download: download,
                cloud: { registry: { resolve: async () => ({ artifactId: "id", kind: "module" as const, name: "@axon/arxiv", version: "4.2.0", downloadUrl: "https://example.test/arxiv" }) } },
                prepare: async (root: string) => { await writeFile(join(root, ".prepared"), "yes") },
            } as any)

            const result = await registry.clone("@axon/arxiv", root)

            expect(result.root).toBe(join(root, "arxiv"))
            expect(JSON.parse(await readFile(join(result.root, "package.json"), "utf-8"))).toMatchObject({ name: "@axon/arxiv", version: "4.2.0" })
            expect(await Bun.file(join(result.root, ".prepared")).text()).toBe("yes")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("forks a clone under a new package identity with immutable provenance", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-fork-"))
        try {
            const body = await archive(root)
            const download = async () => body
            const registry = Registry({
                download: download,
                cloud: { registry: { resolve: async () => ({ artifactId: "id", kind: "module" as const, name: "@axon/arxiv", version: "4.2.0", downloadUrl: "https://example.test/arxiv" }) } },
                prepare: async (root: string) => { await writeFile(join(root, ".prepared"), "yes") },
            } as any)

            const result = await registry.fork("@axon/arxiv", root, { as: "@cody/arxiv-tools" })
            const pkg = JSON.parse(await readFile(join(result.root, "package.json"), "utf-8"))

            expect(result.root).toBe(join(root, "arxiv-tools"))
            expect(pkg).toMatchObject({
                name: "@cody/arxiv-tools",
                version: "0.1.0",
                axon: { forkedFrom: { name: "@axon/arxiv", version: "4.2.0" } },
            })
            expect(await Bun.file(join(result.root, ".prepared")).text()).toBe("yes")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})

/**
 * What a failing `prepare` does to a clone.
 *
 * Two different answers on purpose, and the default is the strict one.
 *
 * `axon clone` was asked to put an artifact in a directory. Its prepare can
 * fail for reasons belonging to the artifact's AUTHOR — the case that forced
 * this was an agent pinning a cognet built for another kernel ABI, which
 * aborted the clone AFTER extracting, leaving a tree on disk, no node_modules,
 * and a fatal error naming a version pin the user never chose.
 *
 * Every other caller (zeno's first-run scaffold, an extension install) asked
 * for a WORKING project and never sees the directory. Returning an error to
 * them would be a silent failure by another name, so they keep the throw.
 */
describe("registry clone — prepare failure", () => {
    function failingRegistry(download: () => Promise<ArrayBuffer>) {
        return Registry({
            cloud: { registry: { resolve: async () => ({ artifactId: "id", kind: "module" as const, name: "@axon/arxiv", version: "4.2.0", downloadUrl: "https://example.test/arxiv" }) } },
            prepare: async () => { throw new Error("COGNET_ABI_MISMATCH") },
            download: download,
        } as any)
    }

    it("throws by default, so an internal caller cannot get a broken tree", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-clone-throw-"))
        try {
            const download = async () => await archive(root)
            await expect(failingRegistry(download).clone("@axon/arxiv", root)).rejects.toThrow("COGNET_ABI_MISMATCH")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("reports instead of throwing when asked, and KEEPS the download", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-clone-report-"))
        try {
            const download = async () => await archive(root)
            const result = await failingRegistry(download).clone("@axon/arxiv", root, { reportPrepareFailure: true })

            // The error is returned, never swallowed — the CLI renders it and
            // exits non-zero. A clone that half-worked must not look like one
            // that worked.
            expect(result.prepareError).not.toBeNull()
            expect(result.prepareError?.message).toContain("COGNET_ABI_MISMATCH")

            // And the files — the thing actually asked for — are on disk.
            expect(JSON.parse(await readFile(join(result.root, "package.json"), "utf-8")))
                .toMatchObject({ name: "@axon/arxiv" })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("reports null when prepare succeeds, so the flag alone never implies failure", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-clone-ok-"))
        try {
            const download = async () => await archive(root)
            const registry = Registry({
                download: download,
                cloud: { registry: { resolve: async () => ({ artifactId: "id", kind: "module" as const, name: "@axon/arxiv", version: "4.2.0", downloadUrl: "https://example.test/arxiv" }) } },
                prepare: async () => {},
            } as any)
            const result = await registry.clone("@axon/arxiv", root, { reportPrepareFailure: true })
            expect(result.prepareError).toBeNull()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})

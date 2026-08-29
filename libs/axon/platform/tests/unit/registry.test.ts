import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Registry } from "@arcforge/platform/services/registry"

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
    const originalFetch = globalThis.fetch

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it("clones one immutable module artifact without a repository", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-clone-"))
        try {
            const body = await archive(root)
            globalThis.fetch = async () => new Response(body) as Response
            const registry = Registry({
                cloud: { registry: { resolve: async () => ({ artifactId: "id", kind: "module" as const, name: "@axon/arxiv", version: "4.2.0", downloadUrl: "https://example.test/arxiv" }) } },
                prepare: async root => { await writeFile(join(root, ".prepared"), "yes") },
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
            globalThis.fetch = async () => new Response(body) as Response
            const registry = Registry({
                cloud: { registry: { resolve: async () => ({ artifactId: "id", kind: "module" as const, name: "@axon/arxiv", version: "4.2.0", downloadUrl: "https://example.test/arxiv" }) } },
                prepare: async root => { await writeFile(join(root, ".prepared"), "yes") },
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

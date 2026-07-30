import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { Cognet } from "../../../src/cognet/cognet"

/**
 * The per-runtime instance copy, and what happens to it when a runtime dies
 * without disposing.
 *
 * A brain's module scope is its resident RAM, so each runtime imports its own
 * physical copy of the compiled bundle under `.agent/cognet/.instances/`.
 * `dispose()` removes it on clean shutdown — but a `kill -9` skips that, and
 * nothing swept the leftovers. They accumulated without bound (21 files /
 * 1.8MB in one local agent) and were published inside release tarballs, where
 * their 130-character names surfaced as `@LongLink` entries in the registry's
 * file tree.
 */

/** A minimal compiled cognet: one self-contained ESM file, default export = definition. */
const BUNDLE = `export default {
    name: "instance-test",
    version: "1.0.0",
    abi: ${JSON.stringify(KERNEL_ABI_VERSION)},
    mode: { kind: "invocation" },
    load() {},
    async wake() {},
}
`

async function bundleOnDisk(): Promise<{ dir: string; path: string; hash: string }> {
    const dir = await mkdtemp(join(tmpdir(), "axon-cognet-instances-"))
    const path = join(dir, "cognet.mjs")
    await writeFile(path, BUNDLE)
    return { dir, path, hash: createHash("sha256").update(await Bun.file(path).bytes()).digest("hex") }
}

function blueprint(path: string, hash: string) {
    return {
        cognet: { name: "instance-test", version: "1.0.0", abi: KERNEL_ABI_VERSION, path, hash },
    } as Parameters<typeof Cognet>[0]["blueprint"]
}

async function instances(dir: string): Promise<string[]> {
    try {
        return await readdir(join(dir, ".instances"))
    } catch {
        return []
    }
}

describe("cognet instance copies", () => {
    it("writes one copy per runtime and removes it on unload", async () => {
        const { dir, path, hash } = await bundleOnDisk()
        try {
            const cognet = await Cognet({ blueprint: blueprint(path, hash) })
            expect(await instances(dir)).toHaveLength(1)

            await cognet.unload()
            expect(await instances(dir)).toHaveLength(0)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("leaves a concurrent runtime's copy alone", async () => {
        const { dir, path, hash } = await bundleOnDisk()
        try {
            const first = await Cognet({ blueprint: blueprint(path, hash) })
            const second = await Cognet({ blueprint: blueprint(path, hash) })

            // Two live runtimes, two distinct copies — booting the second must
            // not sweep the first's, which is a live import.
            expect(await instances(dir)).toHaveLength(2)

            await first.unload()
            await second.unload()
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("sweeps a copy orphaned by a runtime that never disposed", async () => {
        const { dir, path, hash } = await bundleOnDisk()
        try {
            // Stand in for a `kill -9`: a copy on disk with nobody owning it,
            // aged past the staleness window.
            const orphanDir = join(dir, ".instances")
            await mkdir(orphanDir, { recursive: true })
            const orphan = join(orphanDir, `${hash}.dead-runtime.mjs`)
            await writeFile(orphan, BUNDLE)
            const old = new Date(Date.now() - 25 * 60 * 60_000)
            await utimes(orphan, old, old)

            const cognet = await Cognet({ blueprint: blueprint(path, hash) })

            // The orphan is gone; the booting runtime's own copy is not.
            const live = await instances(dir)
            expect(live).toHaveLength(1)
            expect(live[0]).not.toContain("dead-runtime")

            await cognet.unload()
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("keeps a recent copy, which may belong to a runtime still booting", async () => {
        const { dir, path, hash } = await bundleOnDisk()
        try {
            const siblingDir = join(dir, ".instances")
            await mkdir(siblingDir, { recursive: true })
            await writeFile(join(siblingDir, `${hash}.just-started.mjs`), BUNDLE)

            const cognet = await Cognet({ blueprint: blueprint(path, hash) })

            // Freshly written, so it is presumed live and left in place.
            expect(await instances(dir)).toHaveLength(2)

            await cognet.unload()
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { Cognet } from "../../../src/cognet/cognet"

/**
 * Where a compiled cognet is imported from.
 *
 * An agent is its own process and holds one brain at a time, so the bundle is
 * imported where it is. Only a brain swapped in while running needs a path
 * this process has not imported (Bun keys its module registry on the file):
 * that copy sits beside the bundle, named for its hash, and is removed when
 * that brain unloads.
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

describe("cognet bundle import", () => {
    it("imports the first brain in place, writing no copy", async () => {
        const { dir, path, hash } = await bundleOnDisk()
        try {
            const cognet = await Cognet({ blueprint: blueprint(path, hash) })
            expect(await readdir(dir)).toEqual(["cognet.mjs"])
            await cognet.unload()
            expect(await readdir(dir)).toEqual(["cognet.mjs"])
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("imports a re-loaded brain from a hash-named copy beside the bundle, removed on unload", async () => {
        const { dir, path, hash } = await bundleOnDisk()
        try {
            const first = await Cognet({ blueprint: blueprint(path, hash) })
            await first.unload()

            const second = await Cognet({ blueprint: blueprint(path, hash) })
            expect((await readdir(dir)).sort()).toEqual([`cognet.${hash.slice(0, 16)}.mjs`, "cognet.mjs"])

            await second.unload()
            expect(await readdir(dir)).toEqual(["cognet.mjs"])
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

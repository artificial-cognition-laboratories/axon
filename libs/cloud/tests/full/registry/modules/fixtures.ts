import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SOURCE_TARBALL = join(import.meta.dir, "../../fixtures/module-bundle/source.tar.gz")

/**
 * Module Bundle() requires a directory containing both package.json and
 * source.tar.gz side by side, with version read from package.json. Each
 * test needs its own version, so this builds a fresh scratch directory per
 * call rather than mutating the shared fixture. Caller must cleanup().
 */
export async function fixtureModuleBundle(input: { version: string }): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "axon-fixture-module-bundle-"))
    await copyFile(SOURCE_TARBALL, join(dir, "source.tar.gz"))
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-fixture-module", version: input.version }))

    return {
        path: dir,
        cleanup: () => rm(dir, { recursive: true, force: true }),
    }
}

import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureStagingFunds } from "../setup/staging"

const SOURCE_TARBALL = join(import.meta.dir, "../fixtures/agent-bundle/source.tar.gz")

/**
 * Every file that deploys imports this module, so funding the shared account
 * here covers exactly the tests that spend and nothing else.
 *
 * It lives here rather than in preload.ts because preloads do not run in
 * `bun test --parallel` workers: four workers deploying concurrently drained
 * TEST_USER and 24 tests failed with "insufficient balance to deploy: need
 * 4900, have 36" — a billing regression that wasn't one. A module-level await
 * runs once per worker, which is precisely the scope that needs it.
 *
 * OTHER_USER is deliberately untouched — insufficient-funds.test.ts depends on
 * it being permanently broke.
 */
await ensureStagingFunds()

/**
 * An agent bundle directory: source.tar.gz, image.json and package.json side
 * by side — exactly what `axon build` writes into .agent/ (the bundler copies
 * package.json in; see build/project/bundle/artifacts.ts). image.json carries
 * the build manifest, package.json the publishable identity, and Bundle()
 * requires both.
 *
 * The fixture agent's tarball is static and shared, but each test needs its
 * own version — so this builds a fresh scratch directory per call rather than
 * mutating the shared fixture. Caller is responsible for cleanup() once
 * publish() has read the files.
 */
export async function fixtureBundle(input: { version: string }): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "axon-fixture-bundle-"))
    await copyFile(SOURCE_TARBALL, join(dir, "source.tar.gz"))
    await writeFile(
        join(dir, "image.json"),
        JSON.stringify({ version: input.version, public: false, axonVersion: "0.1.0", builtAt: new Date().toISOString() }),
    )
    await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "axon-fixture-agent", version: input.version, private: true }),
    )

    return {
        path: dir,
        cleanup: () => rm(dir, { recursive: true, force: true }),
    }
}

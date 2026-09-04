/**
 * Rebuild `source.tar.gz` from `src/`.
 *
 * ── Why this script exists ──────────────────────────────────────────────────
 *
 * The tarball is a COMPILED artifact — it carries `.agent/cognet/cognet.mjs`,
 * a brain built against a snapshot of the kernel ABI. Committed without a way
 * to regenerate it, it drifts silently: the checked-in copy targeted ABI 10
 * against a kernel at 11, and every deployment test failed with
 * `zero@0.1.2 targets ABI 10, kernel provides 11` — 25 failures with one cause
 * and no obvious fix, because nothing in the repo said where the bytes came
 * from.
 *
 * Faking the manifest's `abi` is explicitly wrong: see KERNEL_ABI_VERSION,
 * which warns that "a stale bundle loads cleanly under a matching version
 * number and misreads events at runtime". The bundle has to be REBUILT.
 *
 * ── Why it is not built at test time ────────────────────────────────────────
 *
 * `libs/cloud` cannot reach the bundler: platform depends on cloud, so cloud
 * importing platform is a cycle. Building here would also put a full cognet
 * compile inside every deployment suite's setup.
 *
 * So it stays a committed artifact, with this script as its provenance. Run it
 * whenever the kernel ABI bumps:
 *
 *     bun run libs/axon/platform/scripts/rebuild-cloud-fixture.ts
 *
 * It lives in PLATFORM rather than beside the fixture because building an
 * agent needs the bundler, and `libs/cloud` cannot import it — platform
 * depends on cloud, so the reverse would be a cycle. The dependency direction
 * decides where a script can live, not what it happens to be about.
 */
import { mkdtemp, rm, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyFile } from "node:fs/promises"
import { Platform } from "@arcforge/platform/platform"

const repoRoot = join(import.meta.dir, "../../../../")
/** The fixture's home — source in `src/`, the built tarball beside it. */
const here = join(repoRoot, "libs/cloud/tests/fixtures/agent-bundle")

const dir = await mkdtemp(join(tmpdir(), "axon-fixture-rebuild-"))
try {

    const platform = Platform({
        version: JSON.parse(await Bun.file(join(repoRoot, "package.json")).text()).version ?? "0.0.0",
        // From the WORKING TREE, never npm: the whole point is a bundle built
        // against the kernel in this commit.
        frameworkSource: "workspace",
        repoRoot,
        store: join(dir, "store"),
    })

    // SCAFFOLD, then overlay. `projects.create` writes a correct package.json
    // for this kernel — the framework deps linked from the working tree, the
    // cognet resolved as the registry resolves it — which a hand-written one
    // in the fixture cannot stay correct about. Only the agent's OWN source is
    // ours to supply, so only that is copied over the top.
    const created = await platform.projects.create("agent", { name: "test-fixture-agent", dir })
    const root = created.root
    await cp(join(here, "src/axon.config.ts"), join(root, "axon.config.ts"))
    await cp(join(here, "src/server"), join(root, "server"), { recursive: true })

    const project = await platform.projects.open(root)
    // prepare() installs the cognet RUNTIME the bundler compiles against —
    // bundle() alone fails with COGNET_BUILD_FAILED because the host package
    // is not in node_modules yet.
    await project.prepare()
    const artifact = await project.bundle()

    await copyFile(artifact.tarball, join(here, "source.tar.gz"))
    console.log(`rebuilt ${join(here, "source.tar.gz")} from ${root}`)
} finally {
    await rm(dir, { recursive: true, force: true })
}

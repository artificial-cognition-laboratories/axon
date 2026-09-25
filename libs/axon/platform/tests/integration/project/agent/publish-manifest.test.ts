import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

/**
 * What a PUBLISH ships, asserted against the actual tarball.
 *
 * ── Why this reads the archive and not the code ─────────────────────────────
 *
 * The bug this exists to prevent was not a wrong entry list. It was a list that
 * was RIGHT for one consumer and wrong for the other: publish and deploy shared
 * one bundler, so the lockfile that makes a deploy reproducible also shipped to
 * everyone who cloned the agent. `@cody/io` published `bun.lock` pinning
 * `@cody/io-engine@0.1.0` (kernel ABI 10); a clone onto an ABI-11 CLI installed
 * that pin and failed at prepare, naming a version nobody in that session had
 * chosen.
 *
 * A test over the entry list would have read as correct at every moment. Only
 * opening the archive answers "what does a consumer actually receive".
 *
 * ── Why an allowlist and not a denylist ─────────────────────────────────────
 *
 * Same reasoning as `PUBLIC_ROUTES` in the backend census and `SAFE_KEYS` in the
 * report scrubber: the published surface is a FIXTURE, not something emergent.
 * A denylist only ever protects against the leaks somebody already thought of,
 * and the whole failure mode here is a file nobody thought about. Adding to
 * PUBLISHED below is a deliberate edit that shows up in a diff and needs a
 * reason.
 */

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Every path a published agent may contain, as a matcher against the tar
 * listing. Directories are prefixes; everything else is an exact name.
 *
 * `.agent/` is the wire contract the deployed container resolves the compiled
 * brain through — see stageCognet(). It is a build output rather than source,
 * and it is included on purpose.
 */
const PUBLISHED: Array<{ match: RegExp; why: string }> = [
    { match: /^src\//, why: "the agent's own source" },
    { match: /^server\//, why: "the agent's HTTP surface" },
    { match: /^modules\//, why: "local source modules, imports rebased" },
    { match: /^cognet\//, why: "an INLINE brain is the agent's own source" },
    { match: /^data\/knowledge\//, why: "authored material that defines what the agent knows" },
    { match: /^\.agent\//, why: "compiled brain + Dockerfile, the deploy wire contract" },
    { match: /^axon\.config\.ts$/, why: "the agent declaration" },
    { match: /^package\.json$/, why: "the dependency DECLARATION — ranges, not a resolution" },
    { match: /^bunfig\.toml$/, why: "the @axon scope → registry mapping; without it no Axon module resolves" },
    { match: /^README\.md$/, why: "rendered on the registry page" },
]

/** Members of a tarball, normalised to project-relative paths. */
async function members(tarball: string): Promise<string[]> {
    const listed = await $`tar tzf ${tarball}`.quiet()
    return listed
        .stdout.toString()
        .split("\n")
        .map(line => line.trim())
        .filter(line => line !== "" && !line.endsWith("/"))
        .map(line => line.replace(/^\.\//, ""))
}

async function bundled(target: "publish" | "deploy") {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
    const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
    const project = await platform.projects.create("agent", { name: disposableName(), dir })
    const { tarball } = await project.bundle(target)
    return {
        files: await members(tarball),
        cleanup: async () => {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        },
    }
}

describe("published agent manifest", () => {
    it("ships no lockfile — a consumer resolves against THEIR kernel", async () => {
        const { files, cleanup } = await bundled("publish")
        try {
            expect(files).not.toContain("bun.lock")
            expect(files.some(file => file.includes("bun.lock"))).toBe(false)
        } finally {
            await cleanup()
        }
    })

    it("ships nothing outside the allowlist", async () => {
        const { files, cleanup } = await bundled("publish")
        try {
            const unlisted = files.filter(file => !PUBLISHED.some(entry => entry.match.test(file)))
            // Names the offenders, so a failure says WHAT leaked rather than
            // only that the count changed.
            expect(unlisted).toEqual([])
        } finally {
            await cleanup()
        }
    })

    it("still ships the declaration a consumer needs to install at all", async () => {
        const { files, cleanup } = await bundled("publish")
        try {
            expect(files).toContain("package.json")
            expect(files).toContain("axon.config.ts")
        } finally {
            await cleanup()
        }
    })
})

describe("deployable agent manifest", () => {
    /**
     * The other half of the invariant, and the reason this is not simply
     * "never ship a lockfile": a deploy MUST carry its resolution, because the
     * image build has to reproduce the tree that was tested.
     */
    it("ships the lockfile — the image build must reproduce what was tested", async () => {
        const { files, cleanup } = await bundled("deploy")
        try {
            expect(files).toContain("bun.lock")
        } finally {
            await cleanup()
        }
    })
})

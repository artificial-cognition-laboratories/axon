import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Manifest, Tree } from "@arcforge/platform/build/project"

/**
 * Verify — the one gate every dependency question resolves to.
 *
 * Each test here is a REAL INCIDENT, reproduced. The system arrived at this
 * primitive by hitting four separate failures that were all the same shape —
 * state on disk disagreeing with the manifest, with nothing checking before
 * trusting it — and patching each with its own bespoke repair. These tests are
 * what stop a fifth from being discovered in production instead of here.
 *
 * The unit under test NEVER repairs. Detection and repair are split so that
 * `--frozen` can ask this exact question and refuse; a check that fixes what it
 * finds can never fail.
 */

const ORIGIN = "https://registry.example"

async function project(files: {
    dependencies?: Record<string, string>
    /** `null` means the directory exists but holds no readable package.json. */
    installed?: Record<string, string | null>
    /** name → the (nonexistent) path its scope directory should point at. */
    dangling?: Record<string, string>
    trackedFrom?: Record<string, string>
}) {
    const root = await mkdtemp(join(tmpdir(), "axon-verify-"))

    await writeFile(
        join(root, "package.json"),
        JSON.stringify({
            name: "probe",
            version: "1.0.0",
            dependencies: files.dependencies ?? {},
            ...(files.trackedFrom ? { axon: { trackedFrom: files.trackedFrom } } : {}),
        }),
        "utf8",
    )

    for (const [name, version] of Object.entries(files.installed ?? {})) {
        const dir = join(root, "node_modules", ...name.split("/"))
        await mkdir(dir, { recursive: true })
        if (version !== null) {
            await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }), "utf8")
        }
    }

    // A grafted project links the SCOPE directory, so an evicted cache tree
    // leaves "@scope" dangling rather than the package path itself.
    for (const [name, target] of Object.entries(files.dangling ?? {})) {
        const [scope] = name.split("/")
        await mkdir(join(root, "node_modules"), { recursive: true })
        await symlink(target, join(root, "node_modules", scope!))
    }

    return {
        root,
        manifest: Manifest({ root }),
        tree: Tree({ root }),
        cleanup: () => rm(root, { recursive: true, force: true }),
    }
}

const check = (p: Awaited<ReturnType<typeof project>>, managed: Record<string, string>) =>
    p.tree.verify({ manifest: p.manifest, managed, registryOrigin: ORIGIN })

describe("verify: version drift", () => {
    test("a package installed BELOW its declared range is stale, not installed", async () => {
        // The bug that made a published fix unreachable: ^0.1.1 permits 0.1.1,
        // the lockfile pinned 0.1.0, and existence was the only check — so the
        // broken version passed as installed forever.
        const p = await project({ installed: { "@t/brain": "0.1.0" } })
        try {
            const report = await check(p, { "@t/brain": "^0.1.1" })
            expect(report.faults).toEqual([
                { kind: "stale", name: "@t/brain", range: "^0.1.1", installed: "0.1.0" },
            ])
            expect(report.needsInstall).toBe(true)
        } finally { await p.cleanup() }
    })

    test("an in-range install is coherent", async () => {
        const p = await project({ installed: { "@t/brain": "0.1.4" } })
        try {
            const report = await check(p, { "@t/brain": "^0.1.1" })
            expect(report.faults).toEqual([])
            expect(report.coherent).toBe(true)
        } finally { await p.cleanup() }
    })

    test("an unparseable range is not treated as drift", async () => {
        // A tag or URL Bun understands and semver does not. Presence is the
        // most that can be checked, and it passed — reporting it as stale
        // would force a reinstall on every prepare, forever.
        const p = await project({ installed: { "@t/brain": "0.1.0" } })
        try {
            const report = await check(p, { "@t/brain": "next" })
            expect(report.faults).toEqual([])
        } finally { await p.cleanup() }
    })
})

describe("verify: absence", () => {
    test("a declared package that is absent is missing", async () => {
        const p = await project({})
        try {
            const report = await check(p, { "@t/brain": "^1.0.0" })
            expect(report.faults).toEqual([{ kind: "missing", name: "@t/brain", range: "^1.0.0" }])
            expect(report.needsInstall).toBe(true)
        } finally { await p.cleanup() }
    })

    test("a package present but unreadable counts as missing", async () => {
        // A half-extracted install. Trusting the directory's existence is what
        // let a corrupt package pass as installed.
        const p = await project({ installed: { "@t/brain": null } })
        try {
            const report = await check(p, { "@t/brain": "^1.0.0" })
            expect(report.faults[0]?.kind).toBe("missing")
        } finally { await p.cleanup() }
    })
})

describe("verify: dangling graft", () => {
    test("a link pointing at a deleted cache tree is dangling, not missing", async () => {
        // THE INCIDENT: node_modules is entirely symlinks into a machine-wide
        // tree cache. LRU eviction deleted the tree while the project still
        // pointed at it, and every package read as simply absent — which sent
        // the user looking for a typo in a config that was correct.
        const gone = join(tmpdir(), "axon-verify-evicted-tree-does-not-exist")
        const p = await project({ dangling: { "@axon/zero": gone } })
        try {
            const report = await check(p, { "@axon/zero": "^1.0.4" })
            expect(report.faults[0]?.kind).toBe("dangling")
            expect(report.needsInstall).toBe(true)
        } finally { await p.cleanup() }
    })

    test("names the link and its target, so the cause is machine state not config", async () => {
        const gone = join(tmpdir(), "axon-verify-evicted-tree-does-not-exist")
        const p = await project({ dangling: { "@axon/zero": gone } })
        try {
            const report = await check(p, { "@axon/zero": "^1.0.4" })
            const fault = report.faults[0]
            expect(fault).toMatchObject({ kind: "dangling", name: "@axon/zero", target: gone })
        } finally { await p.cleanup() }
    })
})

describe("verify: foreign origin", () => {
    test("a range auto-resolved against another registry is foreign", async () => {
        // THE INCIDENT: `track: "latest"` resolved @axon/zero against local
        // staging (which had 1.0.5 from test publishes) and wrote "^1.0.5"
        // into a real agent's manifest. Production's latest was 1.0.4, so
        // every install failed on a version that existed only on one machine.
        const p = await project({
            installed: { "@axon/zero": "1.0.4" },
            trackedFrom: { "@axon/zero": "http://127.0.0.1:3099" },
        })
        try {
            const report = await check(p, { "@axon/zero": "^1.0.5" })
            expect(report.faults[0]).toMatchObject({
                kind: "foreign",
                name: "@axon/zero",
                origin: "http://127.0.0.1:3099",
                current: ORIGIN,
            })
        } finally { await p.cleanup() }
    })

    test("a range from the CURRENT registry is not foreign", async () => {
        const p = await project({
            installed: { "@axon/zero": "1.0.4" },
            trackedFrom: { "@axon/zero": ORIGIN },
        })
        try {
            const report = await check(p, { "@axon/zero": "^1.0.4" })
            expect(report.faults).toEqual([])
        } finally { await p.cleanup() }
    })

    test("a range with NO recorded origin is never second-guessed", async () => {
        // The user's own pin carries no origin. Re-resolving it would turn a
        // deliberate choice into a silent upgrade — the opposite failure.
        const p = await project({ installed: { "@axon/zero": "1.0.4" } })
        try {
            const report = await check(p, { "@axon/zero": "^1.0.4" })
            expect(report.faults).toEqual([])
        } finally { await p.cleanup() }
    })
})

describe("verify: local ranges", () => {
    test("a workspace range on a managed dependency is reported, not repaired", async () => {
        const p = await project({})
        try {
            const report = await check(p, { "@t/local": "workspace:*" })
            expect(report.faults).toEqual([
                { kind: "shadowed", name: "@t/local", range: "workspace:*" },
            ])
        } finally { await p.cleanup() }
    })

    test("shadowing is NOT incoherence — a monorepo must still be able to freeze", async () => {
        // It changes nothing on disk. Making --frozen fail on it would mean a
        // monorepo could never freeze, so this distinction is load-bearing.
        const p = await project({})
        try {
            const report = await check(p, { "@t/local": "workspace:*" })
            expect(report.coherent).toBe(true)
            expect(report.needsInstall).toBe(false)
        } finally { await p.cleanup() }
    })

    test("a file: range is not version-checked at all", async () => {
        // The source on disk IS the answer; there is no version to compare.
        const p = await project({})
        try {
            const report = await check(p, { "@t/local": "file:../local" })
            expect(report.faults).toEqual([])
        } finally { await p.cleanup() }
    })
})

describe("verify: registry mixing", () => {
    async function withBunfig(scopeUrl: string) {
        const p = await project({ installed: { "@axon/zero": "1.0.4" } })
        await writeFile(
            join(p.root, "bunfig.toml"),
            `[install.scopes]\naxon = { url = "${scopeUrl}" }\n`,
            "utf8",
        )
        return p
    }

    test("a bunfig pointing at ANOTHER registry is a fault", async () => {
        // The sharpest form of mixing: ranges resolve against the current
        // registry while tarballs are fetched from the old one. `trackedFrom`
        // cannot catch it — that describes a range, this is about bytes.
        const p = await withBunfig("http://127.0.0.1:3099/api/registry/npm/-")
        try {
            const report = await check(p, { "@axon/zero": "^1.0.4" })
            expect(report.faults[0]).toMatchObject({
                kind: "registry",
                scope: "axon",
                mapped: "http://127.0.0.1:3099/api/registry/npm/-",
                current: ORIGIN,
            })
            // The bytes on disk came from the wrong place, so only a reinstall
            // can correct them.
            expect(report.needsInstall).toBe(true)
        } finally { await p.cleanup() }
    })

    test("a bunfig pointing at the CURRENT registry is fine", async () => {
        const p = await withBunfig(`${ORIGIN}/api/registry/npm/-`)
        try {
            const report = await check(p, { "@axon/zero": "^1.0.4" })
            expect(report.faults).toEqual([])
        } finally { await p.cleanup() }
    })

    test("a scope Axon does not manage is never inspected", async () => {
        // An agent legitimately depends on ordinary npm packages, and those
        // must keep resolving against public npm.
        const p = await withBunfig("https://registry.npmjs.org")
        try {
            const report = await check(p, {})
            expect(report.faults).toEqual([])
        } finally { await p.cleanup() }
    })
})

describe("verify: scope", () => {
    test("a dependency Axon does not manage is never inspected", async () => {
        // A user's own dependency at any version, in any state, is not this
        // system's business — inspecting it would report faults nobody asked
        // for and nothing would repair.
        const p = await project({
            dependencies: { "left-pad": "^1.0.0" },
            installed: { "left-pad": "0.0.1" },
        })
        try {
            const report = await check(p, {})
            expect(report.faults).toEqual([])
            expect(report.coherent).toBe(true)
        } finally { await p.cleanup() }
    })
})

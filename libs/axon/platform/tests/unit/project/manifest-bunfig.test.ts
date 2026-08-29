import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Manifest } from "@arcforge/platform/build/project"

/**
 * bunfig.toml — the scope → registry map, and the file that decides where
 * package BYTES come from.
 *
 * The bug these exist for: `ensure()` returned early the moment a scope was
 * present, without ever checking its URL. So a project prepared against
 * production kept fetching from production after switching to local staging,
 * and vice versa — ranges resolved against one registry while tarballs came
 * from the other. That is the worst form of registry mixing, because each half
 * looks correct on its own.
 *
 * "Already present" and "already correct" are different questions, and only
 * the second licenses doing nothing.
 */

const PROD = "https://prod.example/api/registry/npm/-"
const STAGING = "http://localhost:3099/api/registry/npm/-"

async function bunfig() {
    const root = await mkdtemp(join(tmpdir(), "axon-bunfig-"))
    return {
        root,
        it: Manifest({ root }).bunfig,
        read: () => readFile(join(root, "bunfig.toml"), "utf-8"),
        cleanup: () => rm(root, { recursive: true, force: true }),
    }
}

describe("ensure: adding a scope", () => {
    test("creates the file and maps the scope", async () => {
        const b = await bunfig()
        try {
            expect(await b.it.ensure("axon", PROD)).toBe(true)
            expect(await b.read()).toContain(`axon = { url = "${PROD}" }`)
        } finally { await b.cleanup() }
    })

    test("adding a scope leaves existing ones alone", async () => {
        const b = await bunfig()
        try {
            await b.it.ensure("axon", PROD)
            await b.it.ensure("cody", PROD)
            const source = await b.read()
            expect(source).toContain("axon = ")
            expect(source).toContain("cody = ")
        } finally { await b.cleanup() }
    })

    test("re-ensuring the SAME url changes nothing", async () => {
        const b = await bunfig()
        try {
            await b.it.ensure("axon", PROD)
            expect(await b.it.ensure("axon", PROD)).toBe(false)
        } finally { await b.cleanup() }
    })
})

describe("ensure: correcting a stale registry", () => {
    test("rewrites a scope pointing at a DIFFERENT registry", async () => {
        // THE BUG. This returned false and left the old URL in place, so
        // switching between prod and staging silently kept fetching from
        // whichever was configured first.
        const b = await bunfig()
        try {
            await b.it.ensure("axon", PROD)
            expect(await b.it.ensure("axon", STAGING)).toBe(true)
            expect(await b.read()).toContain(`axon = { url = "${STAGING}" }`)
        } finally { await b.cleanup() }
    })

    test("the OLD url is gone, not merely superseded", async () => {
        // bun reads the first match, so a duplicated scope would silently keep
        // the stale registry — a correction that appends is not a correction.
        const b = await bunfig()
        try {
            await b.it.ensure("axon", PROD)
            await b.it.ensure("axon", STAGING)
            const source = await b.read()
            expect(source).not.toContain(PROD)
            expect(source.match(/^\s*axon\s*=/gm)?.length).toBe(1)
        } finally { await b.cleanup() }
    })

    test("correcting one scope does not disturb another", async () => {
        const b = await bunfig()
        try {
            await b.it.ensure("axon", PROD)
            await b.it.ensure("cody", PROD)
            await b.it.ensure("axon", STAGING)

            const source = await b.read()
            expect(source).toContain(`axon = { url = "${STAGING}" }`)
            expect(source).toContain(`cody = { url = "${PROD}" }`)
        } finally { await b.cleanup() }
    })

    test("survives a hand-edited file with quoting and spacing variations", async () => {
        // Users edit this file. A correction that only matches the exact shape
        // Axon writes would duplicate the scope instead of replacing it.
        const b = await bunfig()
        try {
            await writeFile(
                join(b.root, "bunfig.toml"),
                `[install.scopes]\n  "axon"  = { url = '${PROD}' }\n`,
                "utf8",
            )
            expect(await b.it.ensure("axon", STAGING)).toBe(true)
            const source = await b.read()
            expect(source).toContain(STAGING)
            expect(source).not.toContain(PROD)
        } finally { await b.cleanup() }
    })
})

describe("scopes: what the project maps", () => {
    test("reports every mapped scope and its registry", async () => {
        const b = await bunfig()
        try {
            await b.it.ensure("axon", PROD)
            await b.it.ensure("cody", STAGING)
            expect(await b.it.scopes()).toEqual({ axon: PROD, cody: STAGING })
        } finally { await b.cleanup() }
    })

    test("an absent file maps nothing", async () => {
        const b = await bunfig()
        try {
            expect(await b.it.scopes()).toEqual({})
        } finally { await b.cleanup() }
    })
})

describe("ensureAll: mapping a batch", () => {
    test("maps the scope of every package name given", async () => {
        const b = await bunfig()
        try {
            await b.it.ensureAll(["@axon/zero", "@cody/thing"], PROD)
            expect(await b.it.scopes()).toEqual({ axon: PROD, cody: PROD })
        } finally { await b.cleanup() }
    })

    test("an unscoped name maps nothing — it resolves from public npm", async () => {
        const b = await bunfig()
        try {
            await b.it.ensureAll(["left-pad"], PROD)
            expect(await b.it.scopes()).toEqual({})
        } finally { await b.cleanup() }
    })

    test("corrects a stale scope in a batch", async () => {
        const b = await bunfig()
        try {
            await b.it.ensureAll(["@axon/zero"], PROD)
            expect(await b.it.ensureAll(["@axon/zero"], STAGING)).toBe(true)
            expect(await b.it.scopes()).toEqual({ axon: STAGING })
        } finally { await b.cleanup() }
    })
})

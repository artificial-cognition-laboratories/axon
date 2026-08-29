import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpError } from "@arcforge/types"
import { Manifest } from "@arcforge/platform/build/project"
// Reached past the index deliberately, and only here: Installer is internal —
// consumers get it as `project.modules`. Exporting it to give a test a shorter
// import would widen the package's public boundary for no consumer's benefit.
import { Installer } from "../../../src/build/project/installer"

/**
 * `installer.updates()` and `installer.update()` — what `:module update` reads
 * and what it applies.
 *
 * Two things are pinned here, and both are places where a module differs from
 * an extension in a way that is easy to get silently wrong.
 *
 * ── `current` is the tree, not the range ────────────────────────────────────
 *
 * An extension is pinned exactly, so "am I current" is a string compare. A
 * module declares a RANGE and resolves to an exact version on disk. Reading the
 * range's floor would report `^1.2.0` sitting at 1.2.7 as outdated at 1.2.0 —
 * for every module anyone ever installed with a caret, forever, and `prepare`
 * would never make it go away.
 *
 * ── An update must not narrow the range ─────────────────────────────────────
 *
 * `install()` writes an explicit constraint through verbatim, so an update
 * naively expressed as `install("@a/one@1.3.0")` lands `1.3.0` in package.json
 * and converts the user's caret into a hard pin. They asked to move a version,
 * not to stop tracking patches, and nothing would tell them it happened.
 */

/** A registry that answers with whatever the test says is published. */
function cloud(published: Record<string, string>) {
    return {
        registry: {
            artifacts: {
                async resolve(name: string, constraint?: string) {
                    const latest = published[name]
                    // A real HttpError, not a shape that resembles one: the
                    // installer distinguishes "no such module" from a fault by
                    // `instanceof HttpError && status === 404`, so a look-alike
                    // would test a code path production never takes.
                    if (!latest) throw new HttpError(404, `/api/registry/artifacts/${name}`)
                    // A pinned constraint is honoured; a bare ask gets latest.
                    // Enough registry behaviour for these cases — the real
                    // resolution rules are the backend's and tested there.
                    return { kind: "module" as const, version: constraint?.replace(/^[\^~]/, "") ?? latest }
                },
            },
        },
    }
}

/** node_modules, as far as the installer is concerned. */
function tree(installed: Record<string, string>) {
    return {
        installedVersion: (name: string) => installed[name] ?? null,
        frameworkInstalled: () => true,
        async install() { /* the manifest is what these tests read */ },
    }
}

type Setup = {
    /** name → declared range in package.json */
    declared: Record<string, string>
    /** name → version present in node_modules */
    installed?: Record<string, string>
    /** name → latest published version */
    published?: Record<string, string>
    /** Which names axon.config.ts activates. Defaults to everything declared. */
    activated?: string[]
}

async function project(setup: Setup) {
    const root = await mkdtemp(join(tmpdir(), "axon-installer-updates-"))
    await mkdir(join(root, "node_modules"), { recursive: true })

    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "test-agent", dependencies: setup.declared }, null, 2),
    )

    const activated = setup.activated ?? Object.keys(setup.declared)
    await writeFile(
        join(root, "axon.config.ts"),
        `export default { modules: [${activated.map(name => `"${name}"`).join(", ")}] }\n`,
    )

    const manifest = Manifest({ root })
    // The config is read through the AST, and these tests care about the
    // dependency half — so the activation set is stubbed rather than parsed,
    // keeping the fixture a plain file instead of a compilable agent.
    const declaredNames = manifest.config.declared
    manifest.config.declared = (async () => activated) as typeof declaredNames

    const installer = Installer({
        root,
        cloud: cloud(setup.published ?? {}) as never,
        manifest,
        tree: tree(setup.installed ?? {}) as never,
        during: async <T>(fn: () => Promise<T>) => fn(),
        apiBase: "https://registry.example",
    })

    return {
        installer,
        async packageJson(): Promise<Record<string, string>> {
            const raw = await readFile(join(root, "package.json"), "utf-8")
            return JSON.parse(raw).dependencies
        },
        cleanup: () => rm(root, { recursive: true, force: true }),
    }
}

describe("updates(): what version am I actually on", () => {
    test("reads current from the TREE, not from the declared range", async () => {
        const p = await project({
            declared: { "@a/one": "^1.2.0" },
            installed: { "@a/one": "1.2.7" },
            published: { "@a/one": "1.2.7" },
        })
        try {
            const [entry] = await p.installer.updates()

            // The caret resolved forward to 1.2.7 and that IS current. Reading
            // "1.2.0" off the range would report an update that does not exist.
            expect(entry).toMatchObject({ name: "@a/one", current: "1.2.7", latest: "1.2.7", outdated: false })
            // The range is still reported — a surface has to be able to say
            // when an update crosses it.
            expect(entry?.range).toBe("^1.2.0")
        } finally { await p.cleanup() }
    })

    test("outdated when the tree is behind what is published", async () => {
        const p = await project({
            declared: { "@a/one": "^1.2.0" },
            installed: { "@a/one": "1.2.7" },
            published: { "@a/one": "2.0.0" },
        })
        try {
            expect((await p.installer.updates())[0])
                .toMatchObject({ current: "1.2.7", latest: "2.0.0", outdated: true })
        } finally { await p.cleanup() }
    })

    test("declared but not installed is reported, and is never outdated", async () => {
        const p = await project({
            declared: { "@a/one": "^1.2.0" },
            installed: {},
            published: { "@a/one": "1.3.0" },
        })
        try {
            const [entry] = await p.installer.updates()

            // A fresh clone before `prepare`. The fix is an install, not an
            // update, and calling it outdated sends the user to the wrong one.
            expect(entry).toMatchObject({ current: null, latest: "1.3.0", outdated: false })
        } finally { await p.cleanup() }
    })

    test("an unreachable registry is a row, not a dropped entry", async () => {
        const p = await project({
            declared: { "@a/one": "^1.2.0" },
            installed: { "@a/one": "1.2.0" },
            published: {}, // resolve throws
        })
        try {
            const [entry] = await p.installer.updates()

            // "Could not ask" must stay distinguishable from "nothing new" —
            // dropping the row would render as up to date.
            expect(entry).toMatchObject({ name: "@a/one", current: "1.2.0", latest: null, outdated: false })
        } finally { await p.cleanup() }
    })

    test("only ACTIVATED modules — an ordinary npm dependency is not one", async () => {
        const p = await project({
            declared: { "@a/one": "^1.2.0", "@types/bun": "^1.0.0" },
            installed: { "@a/one": "1.2.0", "@types/bun": "1.0.0" },
            published: { "@a/one": "1.3.0", "@types/bun": "9.9.9" },
            activated: ["@a/one"],
        })
        try {
            const entries = await p.installer.updates()

            // The same test `installed()` applies. Without it every scoped npm
            // package shows up as a module the user can "update".
            expect(entries.map(entry => entry.name)).toEqual(["@a/one"])
        } finally { await p.cleanup() }
    })
})

describe("update(): moving a version must not narrow the range", () => {
    test("a caret range stays a caret range", async () => {
        const p = await project({
            declared: { "@a/one": "^1.2.0" },
            installed: { "@a/one": "1.2.0" },
            published: { "@a/one": "1.3.0" },
        })
        try {
            await p.installer.update([{ name: "@a/one", version: "1.3.0" }])

            // The bug this pins: writing "1.3.0" here silently converts a
            // tracking range into a hard pin, and the user only finds out much
            // later when patches stop arriving.
            expect((await p.packageJson())["@a/one"]).toBe("^1.3.0")
        } finally { await p.cleanup() }
    })

    test("a tilde range stays a tilde range", async () => {
        const p = await project({
            declared: { "@a/one": "~1.2.0" },
            installed: { "@a/one": "1.2.0" },
            published: { "@a/one": "1.3.0" },
        })
        try {
            await p.installer.update([{ name: "@a/one", version: "1.3.0" }])
            expect((await p.packageJson())["@a/one"]).toBe("~1.3.0")
        } finally { await p.cleanup() }
    })

    test("an exact pin stays exact", async () => {
        const p = await project({
            declared: { "@a/one": "1.2.0" },
            installed: { "@a/one": "1.2.0" },
            published: { "@a/one": "1.3.0" },
        })
        try {
            await p.installer.update([{ name: "@a/one", version: "1.3.0" }])

            // A bare version WAS a deliberate choice — widening it to a caret
            // would install versions the user pinned specifically to avoid.
            expect((await p.packageJson())["@a/one"]).toBe("1.3.0")
        } finally { await p.cleanup() }
    })

    test("an ordinary install still pins exactly when the user asks for a version", async () => {
        const p = await project({
            declared: { "@a/one": "^1.2.0" },
            installed: { "@a/one": "1.2.0" },
            published: { "@a/one": "1.3.0" },
        })
        try {
            // `axon install @a/one@1.3.0` means THAT version. keepRange is for
            // update alone, and this is what stops it leaking into install.
            await p.installer.install(["@a/one@1.3.0"])
            expect((await p.packageJson())["@a/one"]).toBe("1.3.0")
        } finally { await p.cleanup() }
    })

    test("moves several modules in one write", async () => {
        const p = await project({
            declared: { "@a/one": "^1.0.0", "@a/two": "^2.0.0" },
            installed: { "@a/one": "1.0.0", "@a/two": "2.0.0" },
            published: { "@a/one": "1.1.0", "@a/two": "2.1.0" },
        })
        try {
            const results = await p.installer.update([
                { name: "@a/one", version: "1.1.0" },
                { name: "@a/two", version: "2.1.0" },
            ])

            expect(results.every(result => result.status === "installed")).toBe(true)
            expect(await p.packageJson()).toMatchObject({ "@a/one": "^1.1.0", "@a/two": "^2.1.0" })
        } finally { await p.cleanup() }
    })

    test("one bad name does not discard the rest of the batch", async () => {
        const p = await project({
            declared: { "@a/one": "^1.0.0", "@a/gone": "^1.0.0" },
            installed: { "@a/one": "1.0.0", "@a/gone": "1.0.0" },
            published: { "@a/one": "1.1.0" }, // @a/gone was unpublished
        })
        try {
            const results = await p.installer.update([
                { name: "@a/one", version: "1.1.0" },
                { name: "@a/gone", version: "1.1.0" },
            ])

            // A partial batch settles partially. The module that resolved has
            // to land — discarding it would mean one unpublished dependency
            // permanently blocks every other update in the agent.
            expect(results.find(result => result.name === "@a/one")?.status).toBe("installed")
            expect(results.find(result => result.name === "@a/gone")?.status).toBe("not-found")
            expect((await p.packageJson())["@a/one"]).toBe("^1.1.0")
        } finally { await p.cleanup() }
    })
})

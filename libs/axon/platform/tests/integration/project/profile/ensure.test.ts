import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"

/**
 * The profile is the one project kind nobody asks for: it is scaffolded and
 * prepared on EVERY boot, for whoever is logged in. That makes idempotence the
 * property under test rather than a nicety — these run against a directory
 * holding the user's own config, credentials and history, so a scaffolder that
 * overwrites is data loss, not an inconvenience.
 */

const EMAIL = "profile-test@axon.dev"

/** A logged-in store with an empty profile directory, cleaned up after `fn`. */
async function withProfile(
    fn: (ctx: { platform: ReturnType<typeof Platform>; root: string }) => Promise<void>,
): Promise<void> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    try {
        // The minimum a Store considers "logged in": an active pointer and a
        // profile record. Written directly rather than through a login flow —
        // these tests are about the directory, not authentication.
        await mkdir(join(storeDir, "profiles", EMAIL, "store"), { recursive: true })
        await writeFile(join(storeDir, "profiles", "index.json"), JSON.stringify({ userId: EMAIL }))
        await writeFile(
            join(storeDir, "profiles", EMAIL, "store", "profile.json"),
            JSON.stringify({ user: { id: "u1", email: EMAIL }, auth: {} }),
        )

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        await fn({ platform, root: platform.profile.root })
    } finally {
        await rm(storeDir, { recursive: true, force: true })
    }
}

/** Typecheck the profile through its own generated tsconfig. */
async function typecheck(root: string): Promise<{ ok: boolean; output: string }> {
    const proc = Bun.spawn(["bun", "x", "tsc", "--noEmit", "-p", "tsconfig.json"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    return { ok: code === 0, output: `${stdout}${stderr}` }
}

describe("profile.ensure", () => {
    test("scaffolds and prepares a first-run profile", async () => {
        await withProfile(async ({ platform, root }) => {
            const project = await platform.profile.ensure()

            expect(project.kind).toBe("profile")

            // What a user writes.
            expect(existsSync(join(root, "main.ts"))).toBe(true)
            expect(existsSync(join(root, "profile.config.ts"))).toBe(true)
            expect(existsSync(join(root, "plugins"))).toBe(true)

            // NOT extensions/. An install creates it when there is something to
            // put in it; most profiles never have one. Asserted rather than
            // simply dropped, because ensure() runs on every boot — a folder
            // reappearing each time the user deletes it is the specific
            // annoyance this is here to prevent.
            expect(existsSync(join(root, "extensions"))).toBe(false)

            // What the platform generates. The frame is .axon, not .profile —
            // the one kind whose directory does not derive from its name.
            expect(existsSync(join(root, ".axon", "types", "globals.d.ts"))).toBe(true)
            expect(existsSync(join(root, ".axon", "types", "tsconfig.json"))).toBe(true)
        }, )
    }, 120_000)

    test("the generated frame typechecks", async () => {
        await withProfile(async ({ platform, root }) => {
            await platform.profile.ensure()

            const result = await typecheck(root)
            expect(result.output).toBe("")
            expect(result.ok).toBe(true)
        })
    }, 120_000)

    test("declares the seven globals", async () => {
        await withProfile(async ({ platform, root }) => {
            await platform.profile.ensure()

            const dts = await readFile(join(root, ".axon", "types", "globals.d.ts"), "utf-8")
            for (const name of ["tui", "palette", "commands", "keys", "mode", "input", "agents"]) {
                expect(dts).toContain(`const ${name}:`)
            }
            expect(dts).toContain("function defineProfile")
            expect(dts).toContain("function defineExtension")

            // The globals are ambient, which requires globals.d.ts to be a
            // module — and the same trailing export is what lets a user's
            // import-free main.ts use top-level await under
            // moduleDetection: force. Removing it silently breaks both.
            expect(dts.trimEnd().endsWith("export {}")).toBe(true)
        })
    }, 120_000)

    test("never overwrites what the user wrote", async () => {
        await withProfile(async ({ platform, root }) => {
            await platform.profile.ensure()

            const main = "// my config\ncommands.register(\"mine\", () => {})\n"
            const config = "export default defineProfile({ extensions: [\"@axon/mine\"] })\n"
            await writeFile(join(root, "main.ts"), main)
            await writeFile(join(root, "profile.config.ts"), config)

            // Every boot calls this. A profile that lost the user's config on
            // the second launch would be catastrophic and silent.
            await platform.profile.ensure()

            expect(await readFile(join(root, "main.ts"), "utf-8")).toBe(main)
            expect(await readFile(join(root, "profile.config.ts"), "utf-8")).toBe(config)
        })
    }, 120_000)

    test("adds directories a profile predating them is missing", async () => {
        await withProfile(async ({ platform, root }) => {
            await platform.profile.ensure()
            await rm(join(root, "plugins"), { recursive: true, force: true })

            // The upgrade path: a release that introduces a new folder must
            // reach existing profiles without the user doing anything.
            await platform.profile.ensure()

            expect(existsSync(join(root, "plugins"))).toBe(true)
        })
    }, 120_000)

    test("a user's own plugin typechecks against the globals", async () => {
        await withProfile(async ({ platform, root }) => {
            await platform.profile.ensure()

            // Exercises the parts a profile's frame exists to provide: ambient
            // globals, top-level await with no imports, and Bun's own globals
            // (which only resolve because the profile installs @arcforge/types).
            await writeFile(
                join(root, "plugins", "sketch.ts"),
                `tui.hook("key:pressed", ({ key, mode }) => {
    tui.info(\`\${key} in \${mode}\`)
})

tui.hook("tui:shutdown", async () => {
    await Bun.write(\`\${process.env.HOME}/log.txt\`, agents.list().length.toString())
})

const picked = await palette.pick(["a", "b"])
if (picked) commands.register(picked, () => {})
`,
            )

            const result = await typecheck(root)
            expect(result.output).toBe("")
            expect(result.ok).toBe(true)
        })
    }, 120_000)
})

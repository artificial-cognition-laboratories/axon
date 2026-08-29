import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK, TEST_FRAMEWORK_PUBLISHED } from "../../../setup/user"

/**
 * An extension is a profile's own config, packaged for someone else — same
 * layout, same globals, same frame. These pin that equivalence down: if an
 * extension could not express what a user's main.ts can, every gap would turn
 * into a feature request, so the two surfaces are asserted to be one.
 */

function disposableName(): string {
    return `@${TEST_USER.username}/test-ext-${crypto.randomUUID().slice(0, 8)}`
}

async function withExtension(
    fn: (ctx: { root: string; platform: ReturnType<typeof Platform> }) => Promise<void>,
): Promise<void> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const dir = await mkdtemp(join(tmpdir(), "axon-test-ext-"))
    try {
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        const project = await platform.projects.create("extension", { name: disposableName(), dir })
        await fn({ root: project.root, platform })
    } finally {
        await rm(storeDir, { recursive: true, force: true })
        await rm(dir, { recursive: true, force: true })
    }
}

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

describe("extension scaffold", () => {
    test("scaffolds the same layout a profile has", async () => {
        await withExtension(async ({ root }) => {
            // main.ts + plugins/ — an extension is a profile, packaged. The
            // config file exists only to mark the kind.
            expect(existsSync(join(root, "main.ts"))).toBe(true)
            expect(existsSync(join(root, "plugins"))).toBe(true)
            expect(existsSync(join(root, "extension.config.ts"))).toBe(true)
            expect(existsSync(join(root, "package.json"))).toBe(true)

            // The frame derives from the kind name — .extension, unlike a
            // profile's .axon.
            expect(existsSync(join(root, ".extension", "types", "globals.d.ts"))).toBe(true)
        })
    }, 120_000)

    test("the scaffolded extension typechecks", async () => {
        await withExtension(async ({ root }) => {
            const result = await typecheck(root)
            expect(result.output).toBe("")
            expect(result.ok).toBe(true)
        })
    }, 120_000)

    test("gets the same globals a profile does", async () => {
        await withExtension(async ({ root }) => {
            const dts = await readFile(join(root, ".extension", "types", "globals.d.ts"), "utf-8")
            for (const name of ["tui", "palette", "commands", "keys", "mode", "input", "agents"]) {
                expect(dts).toContain(`const ${name}:`)
            }
            expect(dts).toContain("function defineExtension")
        })
    }, 120_000)

    test("main.ts registers at module scope, exactly as a profile's does", async () => {
        await withExtension(async ({ root }) => {
            // No setup(), no wrapper, no imports — the same authoring style a
            // user's own main.ts uses, which is what makes "publish my config"
            // a real path rather than a rewrite.
            await writeFile(
                join(root, "main.ts"),
                `import "./keybindings"

commands.register(["review", "open"], {
    async run() {
        const branch = await palette.pick(["main", "dev"])
        if (!branch) return

        // spawn() runs in the background, so going to it is a separate,
        // explicit act before send() (which always targets the focused
        // instance).
        const instance = await agents.spawn("@axon/reviewer")
        agents.focus(instance.id)
        await agents.send(\`review \${branch}\`)
        await agents.stop(instance.id)
    },
    description: "Review a branch",
})

const answer = await palette.confirm("ready?")
if (answer) tui.info("ready")
`,
            )
            await writeFile(join(root, "keybindings.ts"), `keys.register("ctrl+o", () => {})\n`)
            await writeFile(
                join(root, "plugins", "hooks.ts"),
                // A payload hook and an empty one, so the frame is exercised
                // against both shapes — every hook takes one object, and a
                // handler may ignore it.
                `tui.hook("tui:reloaded", () => {
    tui.info("up")
})

tui.hook("tui:resize", ({ width, height }) => {
    tui.info(\`\${width}x\${height}\`)
})
`,
            )

            const result = await typecheck(root)
            expect(result.output).toBe("")
            expect(result.ok).toBe(true)
        })
    }, 120_000)

})

describe("extension publish", () => {
    /** A Platform() whose store already has TEST_USER's key — Cloud() reads it at construction. */
    async function authenticatedPlatform(storeDir: string) {
        const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
        seed.store.profiles.save(TEST_USER.id, {
            user: { id: TEST_USER.id, email: TEST_USER.email },
            auth: { apiKey: TEST_USER.apiKey },
        })
        return Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
    }

    test("registers and uploads a real extension", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-ext-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("extension", { name, dir })

            const result = await project.publish()

            expect(result.name).toBe(name)
            expect(typeof result.registeredId).toBe("string")
            expect(result.version).toBe("0.1.0")
            // Scaffolded extensions declare private:false — public, like a
            // module. An extension exists to be shared.
            expect(result.public).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    test("the published extension is resolvable from the registry", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-ext-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("extension", { name, dir })
            await project.publish()

            // The round trip that matters: an extension is only installable if
            // the registry can resolve it BY KIND, which is what the enum
            // migration bought.
            const resolved = await platform.cloud.client.registry.resolve(name, undefined)
            expect(resolved.version).toBe("0.1.0")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)
})

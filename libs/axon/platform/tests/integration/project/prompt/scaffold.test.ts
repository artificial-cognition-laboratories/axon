import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"

/**
 * A prompt package is the one project kind that installs nothing: it is text,
 * declares no dependencies, and must still typecheck. That combination is
 * what these tests pin down — the frame has to be real (catching a typo'd
 * config key) while node_modules stays absent.
 *
 * The regression behind them: `frame: false` in the kind table meant "no
 * install", and silently also bought "no type declarations", so every
 * scaffolded package shipped with `definePrompt` undeclared.
 */

function disposableName(): string {
    return `@${TEST_USER.username}/test-prompt-${crypto.randomUUID().slice(0, 8)}`
}

/** A scaffolded prompt package in a throwaway dir, cleaned up after `fn`. */
async function withPrompt(fn: (ctx: { root: string; platform: ReturnType<typeof Platform> }) => Promise<void>): Promise<void> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const dir = await mkdtemp(join(tmpdir(), "axon-test-prompt-"))
    try {
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        const project = await platform.projects.create("prompt", { name: disposableName(), dir })
        await fn({ root: project.root, platform })
    } finally {
        await rm(storeDir, { recursive: true, force: true })
        await rm(dir, { recursive: true, force: true })
    }
}

/** Typecheck a project through its own generated tsconfig. */
async function typecheck(root: string): Promise<{ ok: boolean; output: string }> {
    const proc = Bun.spawn(["bun", "x", "tsc", "--noEmit", "-p", "tsconfig.json"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { ok: code === 0, output: stdout + stderr }
}

describe("prompt package: scaffold", () => {
    it("creates the invokable prompt, config, manifest, and components dir", async () => {
        await withPrompt(async ({ root }) => {
            expect(existsSync(join(root, "package.json"))).toBe(true)
            expect(existsSync(join(root, "prompt.config.ts"))).toBe(true)
            expect(existsSync(join(root, "components"))).toBe(true)

            // The prompt is named after the package's bare name, not its scope.
            const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as { name: string }
            const bare = pkg.name.split("/").at(-1)
            expect(existsSync(join(root, `${bare}.vue`))).toBe(true)
        })
    })

    it("ships components/ in the manifest files list", async () => {
        await withPrompt(async ({ root }) => {
            const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as { files: string[] }
            expect(pkg.files).toContain("components")
            expect(pkg.files).toContain("*.vue")
            expect(pkg.files).toContain("*.md")
        })
    })
})

describe("prompt package: prepare", () => {
    it("writes a type frame without installing dependencies", async () => {
        await withPrompt(async ({ root }) => {
            // create() runs prepare(), so the frame exists by now.
            expect(existsSync(join(root, ".prompt", "types", "globals.d.ts"))).toBe(true)
            expect(existsSync(join(root, ".prompt", "types", "tsconfig.json"))).toBe(true)
            expect(existsSync(join(root, "tsconfig.json"))).toBe(true)

            // The whole point: text has no dependencies.
            expect(existsSync(join(root, "node_modules"))).toBe(false)
        })
    })

    it("does not declare framework dependencies it will never install", async () => {
        await withPrompt(async ({ root }) => {
            const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as {
                dependencies?: Record<string, string>
            }
            // A declared-but-absent dependency would ship to every consumer,
            // since package.json is published verbatim.
            expect(pkg.dependencies ?? {}).toEqual({})
        })
    })

    it("is idempotent — preparing twice leaves the package typechecking", async () => {
        await withPrompt(async ({ root, platform }) => {
            const project = await platform.projects.open(root)
            await project.prepare()
            await project.prepare()

            expect(existsSync(join(root, "node_modules"))).toBe(false)
            const { ok, output } = await typecheck(root)
            expect(output).toBe("")
            expect(ok).toBe(true)
        })
    }, 60_000)

    it("reports nothing generated beyond the frame", async () => {
        await withPrompt(async ({ root, platform }) => {
            const project = await platform.projects.open(root)
            const result = await project.prepare()

            expect(result.typegen).toEqual({
                toolGlobals: 0, prompts: 0, scripts: 0, components: 0, env: 0,
            })
            expect(result.modules).toEqual([])
            expect(result.warnings).toEqual([])
        })
    }, 60_000)
})

describe("prompt package: type frame", () => {
    it("typechecks a freshly scaffolded package", async () => {
        await withPrompt(async ({ root }) => {
            const { ok, output } = await typecheck(root)
            expect(output).toBe("")
            expect(ok).toBe(true)
        })
    }, 60_000)

    /**
     * The config is EMPTY on purpose, so every key is an unknown key — the
     * `never` value type is how that is stated, and it is what TypeScript
     * names in the diagnostic.
     */
    it("rejects an unknown config key", async () => {
        await withPrompt(async ({ root }) => {
            await writeFile(
                join(root, "prompt.config.ts"),
                'export default definePrompt({ descriptionn: "typo" })\n',
            )
            const { ok, output } = await typecheck(root)
            expect(ok).toBe(false)
            expect(output).toContain("not assignable to type 'never'")
        })
    }, 60_000)

    /**
     * Identity lives in package.json, and a `description` here would be read
     * by nobody — publish reads pkg.description. Pinning the rejection keeps
     * a future edit from quietly reintroducing a key the registry ignores.
     */
    it("rejects description in the config — identity belongs to package.json", async () => {
        await withPrompt(async ({ root }) => {
            await writeFile(
                join(root, "prompt.config.ts"),
                'export default definePrompt({ description: "scouts a codebase" })\n',
            )
            const { ok, output } = await typecheck(root)
            expect(ok).toBe(false)
            expect(output).toContain("not assignable to type 'never'")
        })
    }, 60_000)
})

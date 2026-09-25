import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveCognetPath } from "@arcforge/platform/build/blueprint/scan/cognetImports"

/**
 * Static resolution of `cognet:` — the same question modules answer, asked of
 * the one brain an agent runs. These tests read a config off disk rather than
 * evaluating it: the whole point of resolving statically is that the answer
 * comes from the import statement, so an evaluated value would prove nothing.
 */

async function withConfig<T>(source: string, fn: (configPath: string, root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "axon-cognet-source-"))
    try {
        const configPath = join(root, "axon.config.ts")
        await writeFile(configPath, source, "utf8")
        return await fn(configPath, root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("cognet source resolution", () => {
    test("a string specifier is a registry cognet", async () => {
        await withConfig(
            `export default defineAgent({ cognet: "@axon/zero" })`,
            async configPath => {
                const resolved = await resolveCognetPath(configPath)
                expect(resolved).toEqual({ kind: "registry", name: "@axon/zero" })
            },
        )
    })

    test("a relative import resolves to the cognet.config.ts on disk", async () => {
        await withConfig(
            `import Vehicle from "./brain/cognet.config"\n`
            + `export default defineAgent({ cognet: Vehicle })`,
            async (configPath, root) => {
                const brain = join(root, "brain")
                await mkdir(brain, { recursive: true })
                await writeFile(join(brain, "cognet.config.ts"), "export default {}", "utf8")

                const resolved = await resolveCognetPath(configPath)
                expect(resolved).toEqual({ kind: "source", configPath: join(brain, "cognet.config.ts") })
            },
        )
    })

    test("a relative import naming the directory finds its cognet.config.ts", async () => {
        await withConfig(
            `import Vehicle from "./brain"\n`
            + `export default defineAgent({ cognet: Vehicle })`,
            async (configPath, root) => {
                const brain = join(root, "brain")
                await mkdir(brain, { recursive: true })
                await writeFile(join(brain, "cognet.config.ts"), "export default {}", "utf8")

                const resolved = await resolveCognetPath(configPath)
                expect(resolved).toEqual({ kind: "source", configPath: join(brain, "cognet.config.ts") })
            },
        )
    })

    test("a BARE import specifier is a registry cognet, not source", async () => {
        // The distinction that keeps an installed package from being treated as
        // a path: bare means node_modules, relative means source on disk.
        await withConfig(
            `import Zero from "@axon/zero/cognet.config"\n`
            + `export default defineAgent({ cognet: Zero })`,
            async configPath => {
                const resolved = await resolveCognetPath(configPath)
                expect(resolved).toEqual({ kind: "registry", name: "@axon/zero" })
            },
        )
    })

    test("an import that resolves to nothing is unresolved, never silently defaulted", async () => {
        await withConfig(
            `import Missing from "./nowhere/cognet.config"\n`
            + `export default defineAgent({ cognet: Missing })`,
            async configPath => {
                const resolved = await resolveCognetPath(configPath)
                expect(resolved?.kind).toBe("unresolved")
            },
        )
    })

    test("an identifier that was never imported is unresolved", async () => {
        await withConfig(
            `const Vehicle = {}\n`
            + `export default defineAgent({ cognet: Vehicle })`,
            async configPath => {
                const resolved = await resolveCognetPath(configPath)
                expect(resolved?.kind).toBe("unresolved")
            },
        )
    })

    test("no cognet declared resolves to null", async () => {
        // Distinct from unresolved: nothing was asked for, so prepare tracks the
        // registry default rather than failing.
        await withConfig(
            `export default defineAgent({ engine: Axon({ model: "auto" }) })`,
            async configPath => {
                expect(await resolveCognetPath(configPath)).toBeNull()
            },
        )
    })
})

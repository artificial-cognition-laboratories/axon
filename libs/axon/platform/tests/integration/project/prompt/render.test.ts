import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Prompt } from "../../../../../core/src/runtime/source/render"
import type { AxonBlueprint } from "@arcforge/types"
import { scanPromptPackage } from "../../../../src/build/blueprint/scan/promptPackages"
import { describe, it, expect } from "bun:test"

/**
 * Rendering an installed prompt through the runtime's own path.
 *
 * The scan tests prove components are FOUND. These prove they are USED —
 * which is where the bug actually was: the renderer never passed components
 * to vstr, so a prompt composing a fragment threw at the moment of use while
 * every earlier step reported success.
 */

/** Stage a prompt package into node_modules and scan it into a blueprint. */
async function withRendered(
    files: Record<string, string>,
    fn: (render: (name: string, props?: Record<string, unknown>) => Promise<string>) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-render-"))
    const name = "@scope/pack"
    try {
        const packageRoot = join(root, "node_modules", ...name.split("/"))
        for (const [relative, contents] of Object.entries(files)) {
            const target = join(packageRoot, relative)
            await mkdir(join(target, ".."), { recursive: true })
            await writeFile(target, contents)
        }
        await writeFile(
            join(packageRoot, "package.json"),
            JSON.stringify({ name, version: "0.1.0", type: "module" }, null, 2),
        )

        const scanned = await scanPromptPackage(packageRoot, name)
        const blueprint = { prompts: scanned.entries, env: {} } as unknown as AxonBlueprint
        await fn(Prompt({ blueprint }).render)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("prompt package: render", () => {
    it("inlines a composed component's content", async () => {
        await withRendered(
            {
                "pack.vue": "<template><h1>Outer</h1><Shared /></template>\n",
                "components/shared.vue": "<template><p>fragment body</p></template>\n",
            },
            async render => {
                const out = await render("@scope/pack:pack")

                expect(out).toContain("Outer")
                // The whole point: the fragment's text, not its tag.
                expect(out).toContain("fragment body")
                expect(out).not.toContain("<Shared")
            },
        )
    })

    it("renders a prompt that composes several components", async () => {
        await withRendered(
            {
                "pack.vue": "<template><Alpha /><Beta /></template>\n",
                "components/alpha.vue": "<template><p>first fragment</p></template>\n",
                "components/beta.vue": "<template><p>second fragment</p></template>\n",
            },
            async render => {
                const out = await render("@scope/pack:pack")

                expect(out).toContain("first fragment")
                expect(out).toContain("second fragment")
            },
        )
    })

    it("renders a prompt with no components", async () => {
        await withRendered(
            { "pack.vue": "<template><p>standalone</p></template>\n" },
            async render => {
                await expect(render("@scope/pack:pack")).resolves.toContain("standalone")
            },
        )
    })

    it("renders a static .md prompt as-is", async () => {
        await withRendered({ "pack.md": "# Heading\n\nplain markdown\n" }, async render => {
            const out = await render("@scope/pack:pack")

            expect(out).toContain("plain markdown")
        })
    })

    it("answers to the bare package name for a single self-titled prompt", async () => {
        await withRendered(
            {
                "pack.vue": "<template><Shared /></template>\n",
                "components/shared.vue": "<template><p>via bare name</p></template>\n",
            },
            async render => {
                await expect(render("@scope/pack")).resolves.toContain("via bare name")
            },
        )
    })

    it("fails loudly when a composed component is missing", async () => {
        await withRendered(
            { "pack.vue": "<template><Missing /></template>\n" },
            async render => {
                // Unresolvable is a real error, not a silently-empty render —
                // an agent must never receive a prompt with its content
                // quietly dropped.
                await expect(render("@scope/pack:pack")).rejects.toThrow()
            },
        )
    })

    it("throws a structured error for an unknown prompt", async () => {
        await withRendered({ "pack.vue": "<template><p>x</p></template>\n" }, async render => {
            await expect(render("@scope/pack:nope")).rejects.toThrow()
        })
    })
})

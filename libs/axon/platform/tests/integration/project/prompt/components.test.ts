import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Prompts } from "../../../../src/build/blueprint/scan/prompts"
import { scanPromptPackage } from "../../../../src/build/blueprint/scan/promptPackages"

/**
 * Components are inlined into a prompt at render time. They are never
 * invokable themselves — a component is an authoring fragment, not a unit of
 * work an agent can run.
 *
 * The regression these pin: components were scanned only for typegen, and
 * never handed to the renderer. A prompt composing <FeedbackLoop /> installed
 * correctly, listed correctly, and threw on render — which is every prompt
 * package in the registry that was large enough to need splitting up.
 */

const TEMPLATE = "<template><p>body</p></template>\n"

/** A flat prompt package staged where `axon install` puts one. */
async function withPackage(
    files: Record<string, string>,
    fn: (ctx: { root: string; name: string; packageRoot: string }) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-host-"))
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
        await fn({ root, name, packageRoot })
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("prompt package: components", () => {
    it("carries a package's components on its prompts", async () => {
        await withPackage(
            {
                "pack.vue": "<template><p>x</p><Shared /></template>\n",
                "components/shared.vue": TEMPLATE,
            },
            async ({ name, packageRoot }) => {
                const scanned = await scanPromptPackage(packageRoot, name)
                const entry = scanned.entries.find(e => e.name === `${name}:pack`)

                expect(entry?.components).toBeDefined()
                expect(Object.keys(entry!.components!)).toEqual(["Shared"])
            },
        )
    })

    it("names components in PascalCase from their filename", async () => {
        await withPackage(
            {
                "pack.vue": TEMPLATE,
                "components/feedback-loop.vue": TEMPLATE,
            },
            async ({ name, packageRoot }) => {
                const scanned = await scanPromptPackage(packageRoot, name)
                const entry = scanned.entries.find(e => e.name === `${name}:pack`)

                expect(Object.keys(entry!.components!)).toEqual(["FeedbackLoop"])
            },
        )
    })

    it("does not make components invokable", async () => {
        await withPackage(
            {
                "pack.vue": TEMPLATE,
                "components/shared.vue": TEMPLATE,
            },
            async ({ name, packageRoot }) => {
                const scanned = await scanPromptPackage(packageRoot, name)

                // A component is a fragment, not a unit of work.
                expect(scanned.entries.some(e => e.name.includes("shared"))).toBe(false)
                expect(scanned.entries.some(e => e.name.includes("Shared"))).toBe(false)
            },
        )
    })

    it("leaves components absent when a package ships none", async () => {
        await withPackage({ "pack.vue": TEMPLATE }, async ({ name, packageRoot }) => {
            const scanned = await scanPromptPackage(packageRoot, name)
            const entry = scanned.entries.find(e => e.name === `${name}:pack`)

            expect(entry?.components).toBeUndefined()
        })
    })

    it("scopes components to their own package", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-test-host-"))
        try {
            for (const [name, component] of [["@scope/one", "alpha"], ["@scope/two", "beta"]] as const) {
                const packageRoot = join(root, "node_modules", ...name.split("/"))
                await mkdir(join(packageRoot, "components"), { recursive: true })
                await writeFile(join(packageRoot, `${name.split("/")[1]}.vue`), TEMPLATE)
                await writeFile(join(packageRoot, "components", `${component}.vue`), TEMPLATE)
                await writeFile(
                    join(packageRoot, "package.json"),
                    JSON.stringify({ name, version: "0.1.0", type: "module" }, null, 2),
                )
            }

            const scannedOne = await scanPromptPackage(join(root, "node_modules", "@scope", "one"), "@scope/one")
            const scannedTwo = await scanPromptPackage(join(root, "node_modules", "@scope", "two"), "@scope/two")
            const one = scannedOne.entries.find(e => e.name === "@scope/one:one")
            const two = scannedTwo.entries.find(e => e.name === "@scope/two:two")

            // Two cached packages must not see each other's fragments —
            // otherwise a common name like <Glossary /> collides between two
            // prompts that were never meant to know about each other.
            expect(Object.keys(one!.components!)).toEqual(["Alpha"])
            expect(Object.keys(two!.components!)).toEqual(["Beta"])
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("carries components for an agent's own prompts too", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-test-agent-"))
        try {
            await mkdir(join(root, "src", "prompts", "components"), { recursive: true })
            await writeFile(join(root, "src", "prompts", "session.vue"), TEMPLATE)
            await writeFile(join(root, "src", "prompts", "components", "identity.vue"), TEMPLATE)

            const scanned = await Prompts(root)
            const entry = scanned.entries.find(e => e.name === "session")

            expect(Object.keys(entry!.components!)).toEqual(["Identity"])
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})

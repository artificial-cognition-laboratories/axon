import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * The schema is authored as a TypeScript type and must survive as a runtime
 * value — coverage and cohort comparability both read it from the manifest,
 * not from the type. These pin that translation.
 */

async function bench(config: string, test = `it("noop", () => { observe("score", 1) })`): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-bench-schema-"))
    await mkdir(join(root, "tests"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "schema-fixture", version: "0.1.0", type: "module" }))
    await writeFile(join(root, "bench.config.ts"), config)
    await writeFile(join(root, "tests", "probe.bench.ts"), `import { expect, it } from "bun:test"\n${test}\n`)
    return root
}

describe("bench schema extraction", () => {
    it("turns a TypeScript type into runtime measurements", async () => {
        const root = await bench(`
            type Schema = {
                /** Did it work? */
                resolved: boolean

                /** Files touched beyond the target. @objective minimize @unit files */
                collateral: number

                /** Strategy taken. */
                approach: "refactor" | "patch"
            }
            export default defineBench<Schema>({ description: "schema fixture" })
        `)

        try {
            const config = await (await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: root }).projects.openAs("bench", root)).bench!.config()
            const byId = Object.fromEntries(config.measurements.map(m => [m.id, m]))

            // Property name is the id; the doc comment is the description.
            expect(byId.resolved?.description).toBe("Did it work?")

            // The declared TYPE decides the kind — nothing states it twice.
            expect(byId.resolved?.value.kind).toBe("boolean")
            expect(byId.collateral?.value.kind).toBe("number")
            expect(byId.approach?.value).toEqual({ kind: "category", values: ["refactor", "patch"] })

            // Aggregation follows from kind unless overridden.
            expect(byId.resolved?.aggregate).toBe("rate")
            expect(byId.collateral?.aggregate).toBe("mean")

            // Direction is the one thing that cannot be inferred, so it is the
            // one thing the author still writes.
            expect(byId.collateral?.objective).toBe("minimize")
            expect(byId.resolved?.objective).toBeUndefined()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 60_000)

    it("fails prepare rather than falling back to an empty schema", async () => {
        // An empty schema silently makes every measurement undeclared, so
        // coverage stops meaning anything. A broken type must be loud.
        const root = await bench(`
            type Schema = { broken: { nested: true } }
            export default defineBench<Schema>({ description: "bad schema" })
        `)

        try {
            await expect((await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: root }).projects.openAs("bench", root)).bench!.config()).rejects.toThrow(/measurement/)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 60_000)

    it("re-extracts when the config changes and reuses the cache when it does not", async () => {
        const root = await bench(`
            type Schema = {
                /** First. */
                one: boolean
            }
            export default defineBench<Schema>({ description: "cache fixture" })
        `)

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: root })
            expect((await (await platform.projects.openAs("bench", root)).bench!.config()).measurements.map(m => m.id)).toEqual(["one"])

            await writeFile(join(root, "bench.config.ts"), `
                type Schema = {
                    /** First. */
                    one: boolean

                    /** Second. */
                    two: number
                }
                export default defineBench<Schema>({ description: "cache fixture" })
            `)

            // Keyed on config content, so an edit invalidates and a re-read does not.
            expect((await (await platform.projects.openAs("bench", root)).bench!.config()).measurements.map(m => m.id)).toEqual(["one", "two"])
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 60_000)
})

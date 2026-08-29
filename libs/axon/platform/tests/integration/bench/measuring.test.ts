import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * The one rule that separates a benchmark from a test suite: expect guards the
 * EXPERIMENT, observe records the SUBJECT. A benchmark whose weak conditions
 * all failed would report itself broken if these collapsed into one verb.
 */

async function bench(test: string, config?: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-bench-measuring-"))
    await mkdir(join(root, "tests"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "measuring-fixture", version: "0.1.0", type: "module" }))
    await writeFile(join(root, "bench.config.ts"), config ?? `
        type Schema = {
            /** Whether the subject succeeded. */
            success: boolean
        }
        export default defineBench<Schema>({ description: "measuring fixture" })
    `)
    await writeFile(join(root, "tests", "probe.bench.ts"), `import { expect, it } from "bun:test"\n${test}\n`)
    return root
}

describe("bench measuring", () => {
    it("records a false observation as a completed trial, not a failure", async () => {
        // THE invariant. A model that fails every trial is the finding — if
        // observing `false` failed the trial, the benchmark would report itself
        // broken exactly when it had the most to say.
        const root = await bench(`it("scores badly", () => { observe("success", false) })`)

        try {
            const result = await (await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: root }).projects.openAs("bench", root)).bench!.run()

            expect(result.trials[0]?.status).toBe("passed")
            expect(result.observations).toHaveLength(1)
            expect(result.observations[0]?.value).toEqual({ kind: "boolean", value: false })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 90_000)

    it("marks the trial failed when expect throws, and keeps observations made before it", async () => {
        // expect() failing means the SCENARIO was wrong, so the trial is not a
        // measurement of the subject. Anything already observed still stands as
        // evidence of how far it got.
        const root = await bench(`
            it("harness broke", () => {
                observe("success", true)
                expect(1).toBe(2)
            })
        `)

        try {
            const result = await (await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: root }).projects.openAs("bench", root)).bench!.run()

            expect(result.trials[0]?.status).toBe("failed")
            expect(result.observations).toHaveLength(1)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 90_000)

    it("collects every observation in a trial, not just the first", async () => {
        // observe() never throws, which is what lets a scenario record several
        // measurements. Under expect() semantics the second would be lost
        // whenever the first was interesting.
        const root = await bench(
            `it("many", () => { observe("a", 1); observe("b", false); observe("c", "x") })`,
            `
                type Schema = {
                    /** A. */
                    a: number
                    /** B. */
                    b: boolean
                    /** C. */
                    c: string
                }
                export default defineBench<Schema>({ description: "multi fixture" })
            `,
        )

        try {
            const result = await (await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: root }).projects.openAs("bench", root)).bench!.run()
            expect(result.observations.map(o => o.measurementId).sort()).toEqual(["a", "b", "c"])
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 90_000)

    it("reports a declared measurement that never fired", async () => {
        // Coverage exists so "scored zero" and "never ran" stay different facts.
        const root = await bench(
            `it("silent", () => { expect(true).toBe(true) })`,
            `
                type Schema = {
                    /** Never observed. @required */
                    missing: boolean
                }
                export default defineBench<Schema>({ description: "coverage fixture" })
            `,
        )

        try {
            const result = await (await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: root }).projects.openAs("bench", root)).bench!.run()

            expect(result.observations).toHaveLength(0)
            expect(result.coverage.expectedMeasurements).toBeGreaterThan(result.coverage.observedMeasurements)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 90_000)
})

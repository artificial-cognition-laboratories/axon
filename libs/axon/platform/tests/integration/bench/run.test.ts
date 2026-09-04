import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"

describe("benchmark local vertical slice", () => {
    it("prepares typed globals, executes a matrix, persists evidence, and replays exactly", async () => {
        const store = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const root = await mkdtemp(join(tmpdir(), "axon-test-bench-run-"))
        try {
            await mkdir(join(root, "tests"), { recursive: true })
            await mkdir(join(root, "workspace"), { recursive: true })
            await Bun.write(join(root, "workspace", "seed.txt"), "original")
            await Bun.write(join(root, "package.json"), JSON.stringify({ name: "local-eval", version: "0.1.0" }))
            await Bun.write(join(root, "bench.config.ts"), `
                type Schema = {
                    /** Fixture score @objective maximize @required */
                    score: number
                }

                export default defineBench<Schema>({
                    description: "local integration fixture",
                    workspace: { source: "./workspace", retain: "failed" },
                    matrix: { "env.VARIANT": ["a", "b"] },
                    artifacts: [{ id: "answer", label: "Answer", description: "Fixture evidence", role: "output" }],
                    trials: 2,
                })
            `)
            await Bun.write(join(root, "tests", "score.bench.ts"), `
                import { expect, it } from "bun:test"
                it("records one result", async () => {
                    const variant = bench.axis("env.VARIANT")
                    expect(await Bun.file(bench.workspace + "/seed.txt").text()).toBe("original")
                    await Bun.write(bench.workspace + "/seed.txt", variant)
                    await Bun.write(bench.workspace + "/created.txt", "new")
                    bench.observe("score", variant === "a" ? 1 : 0.5)
                    await bench.attach("answer", { variant })
                    expect(variant).toBeTruthy()
                })
            `)

            const benchmark = (await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store }).projects.openAs("bench", root)).bench!
            const prepared = await benchmark.prepare()
            expect(prepared.typegen.measurements).toBe(1)
            expect(await Bun.file(join(root, ".bench", "types", "bench.d.ts")).text()).toContain('"score": number')

            const result = await benchmark.run()
            expect(result.manifest.cells).toHaveLength(2)
            expect(result.manifest.bench.name).toBe("local-eval")
            expect(result.manifest.bench.version).toBe("0.1.0")
            expect(result.manifest.workspace.files).toBe(1)
            expect(result.trials).toHaveLength(4)
            expect(result.observations).toHaveLength(4)
            expect(result.artifacts.filter(item => item.owner !== "framework")).toHaveLength(4)
            expect(result.artifacts.filter(item => item.definitionId === "axon.workspace.changes")).toHaveLength(4)
            expect(result.artifacts.filter(item => item.definitionId === "axon.workspace.changes").every(item => item.display === "hidden")).toBe(true)
            const workspaceArtifact = result.artifacts.find(item => item.definitionId === "axon.workspace.changes")!
            const workspaceResult = await Bun.file(join(root, ".bench", "runs", result.manifest.runId, workspaceArtifact.ref)).json()
            expect(workspaceResult.summary).toEqual({ added: 1, modified: 1, deleted: 0, bytesChanged: 11 })
            expect(result.coverage.expectedTrials).toBe(4)
            expect(result.coverage.completedTrials).toBe(4)

            const replayed = await benchmark.result(result.manifest.runId)
            expect(replayed).toEqual(result)
            expect(await Bun.file(join(root, ".bench", "runs", result.manifest.runId, "events.jsonl")).exists()).toBe(true)
            expect(await Bun.file(join(root, ".bench", "runs", result.manifest.runId, "manifest.json")).exists()).toBe(true)
            expect(await Bun.file(join(root, ".bench", "runs", result.manifest.runId, "result.json")).exists()).toBe(true)
            const events = await Bun.file(join(root, ".bench", "runs", result.manifest.runId, "events.jsonl")).text()
            expect(events.match(/bench:workspace:cleaned/g)).toHaveLength(4)
            expect(events).not.toContain("bench:workspace:retained")
        } finally {
            await rm(store, { recursive: true, force: true })
            await rm(root, { recursive: true, force: true })
        }
    }, 30_000)

    it("scaffolds a benchmark that prepares immediately", async () => {
        const store = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-bench-init-"))
        try {
            const benchmark = (await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store }).projects.create("bench", { name: "sample", dir })).bench!
            expect(await Bun.file(join(benchmark.root, ".bench", "types", "bench.d.ts")).exists()).toBe(true)
            expect((await benchmark.config()).measurements).toHaveLength(1)
        } finally {
            await rm(store, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("retains failed attempt workspaces and records their changes", async () => {
        const store = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const root = await mkdtemp(join(tmpdir(), "axon-test-bench-retain-"))
        try {
            await mkdir(join(root, "tests"), { recursive: true })
            await mkdir(join(root, "workspace"), { recursive: true })
            await Bun.write(join(root, "workspace", "seed.txt"), "original")
            await Bun.write(join(root, "package.json"), JSON.stringify({ name: "retain-eval", version: "0.1.0" }))
            await Bun.write(join(root, "bench.config.ts"), `export default defineBench({
                description: "retention fixture",
                workspace: { source: "./workspace", retain: "failed" },
            })`)
            await Bun.write(join(root, "tests", "failure.bench.ts"), `
                import { expect, it } from "bun:test"
                it("retains its failed world", async () => {
                    await Bun.write(bench.workspace + "/marker.txt", "retained")
                    expect(true).toBe(false)
                })
            `)

            const result = await (await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store }).projects.openAs("bench", root)).bench!.run()
            expect(result.trials[0]?.status).toBe("failed")
            const retained = []
            const glob = new Bun.Glob("**/marker.txt")
            for await (const path of glob.scan({ cwd: join(root, ".bench", "workspace"), onlyFiles: true })) retained.push(path)
            expect(retained).toHaveLength(1)
            expect(await Bun.file(join(root, ".bench", "workspace", retained[0]!)).text()).toBe("retained")
        } finally {
            await rm(store, { recursive: true, force: true })
            await rm(root, { recursive: true, force: true })
        }
    })

    it("rejects template symlinks before execution", async () => {
        const store = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const root = await mkdtemp(join(tmpdir(), "axon-test-bench-link-"))
        try {
            await mkdir(join(root, "tests"), { recursive: true })
            await mkdir(join(root, "workspace"), { recursive: true })
            await Bun.write(join(root, "package.json"), JSON.stringify({ name: "link-eval", version: "0.1.0" }))
            await Bun.write(join(root, "bench.config.ts"), `export default defineBench({ description: "link fixture", workspace: { source: "./workspace" } })`)
            await Bun.write(join(root, "tests", "noop.bench.ts"), `it("noop", () => expect(true).toBe(true))`)
            await symlink("../bench.config.ts", join(root, "workspace", "config-link"))

            await expect((await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store }).projects.openAs("bench", root)).prepare()).rejects.toThrow(/resolves outside the workspace source/)
        } finally {
            await rm(store, { recursive: true, force: true })
            await rm(root, { recursive: true, force: true })
        }
    })
})

import type { AxonCloudClient } from "@arcforge/cloud"
import type { BenchConfig, BenchRunResult } from "@arcforge/types"
import { Discover } from "./discover"
import { BenchLog } from "./log"
import { Matrix } from "./matrix"
import { Projection } from "./projection"
import { Resolver } from "./resolve"
import { Runner } from "./runner"
import type { TestRunnerT } from "../../services/test"
import { BenchTypegen } from "./typegen"
import { PrepareBench } from "./prepare"
import { Agents, type AgentsOpts } from "./agents"

/**
 * The collaborators a bench needs that no other project kind does. Threaded
 * from Platform through Projects, so Project() can build a Bench without
 * knowing what a test runner is.
 */
export type BenchExtras = {
    tests: TestRunnerT
    clone: AgentsOpts["clone"]
    prepare: AgentsOpts["prepare"]
}

export type BenchOpts = BenchExtras & {
    root: string
    cloud: AxonCloudClient
}

/**
 * The benchmark verbs of a bench project — run, result, coordinates, config.
 *
 * Composition only; behavior lives in the leaves. This is NOT a project
 * manager: finding, opening, scaffolding, preparing and publishing a bench are
 * Project()'s, exactly as for every other kind. What lives here is only what is
 * genuinely about benchmarking.
 */
export function Bench(opts: BenchOpts) {
    const discover = Discover({ root: opts.root })
    const matrix = Matrix()
    const log = BenchLog({ root: opts.root })
    const resolver = Resolver()
    const runner = Runner({ root: opts.root, log, resolver, tests: opts.tests })
    const projection = Projection()
    const typegen = BenchTypegen({ root: opts.root })
    const agents = Agents({ root: opts.root, clone: opts.clone, prepare: opts.prepare })
    const prepare = PrepareBench({ root: opts.root, discover, typegen, agents })

    return {
        root: opts.root,

        config(): Promise<BenchConfig> {
            return discover.load()
        },

        async coordinates() {
            const config = await discover.load()
            return matrix.build(config.axes)
        },

        /** Execute Bun, persist events, then derive the portable result by replay. */
        async run(): Promise<BenchRunResult> {
            const config = await discover.load()
            const coordinates = matrix.build(config.axes)
            // Resolve agents before running: a registry ref must be fetched and
            // prepared, and its version is what the manifest pins.
            const resolvedAgents = await agents.resolve(config.axes)
            const agentPins = new Map([...resolvedAgents].map(([ref, agent]) => [ref, agent.pin]))
            const agentRoots = Object.fromEntries([...resolvedAgents].map(([ref, agent]) => [ref, agent.root]))
            const runId = await runner.run(config, coordinates, agentPins, agentRoots)
            const result = projection.build(config, await log.read(runId))
            await log.writeManifest(runId, result.manifest)
            await log.writeResult(runId, result)
            return result
        },

        /** Rebuild a result without executing anything. */
        async result(runId: string): Promise<BenchRunResult> {
            const config = await discover.load()
            return projection.build(config, await log.read(runId))
        },

        /**
         * The bench half of `axon prepare` — validate the matrix's local
         * refs, resolve the agents it names, materialize the workspace
         * template, and generate declarations from the config's axes.
         *
         * Project.prepare() calls this after writing the shared frame, so
         * `axon prepare` in a bench does the whole job in one verb. It stays
         * exposed because run() needs its resolved result.
         */
        prepare,
    }
}

export type BenchT = ReturnType<typeof Bench>

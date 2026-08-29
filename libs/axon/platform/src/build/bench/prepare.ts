import { resolveTestFiles } from "../../services/test"
import { isAbsolute, resolve } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../utils/fs"
import type { DiscoverT } from "./discover"
import type { BenchTypegenT } from "./typegen"
import type { BenchAxis } from "@arcforge/types"
import type { AgentsT } from "./agents"
import { Workspace } from "./workspace"

export type BenchPrepareResult = {
    typegen: Awaited<ReturnType<BenchTypegenT["write"]>>
    tests: string[]
    /** Agents the matrix names, with the identity each resolved to. */
    agents: Array<{ ref: string; pin: string }>
    warnings: string[]
    workspace: Awaited<ReturnType<ReturnType<typeof Workspace>["prepare"]>>["template"]
}

/**
 * Variations that name something on disk, so prepare can fail early rather
 * than mid-run. `agent` and `cognet` variations are bare paths or registry
 * refs; everything else is a value the runtime merges, not a location.
 */
function localRefs(axis: BenchAxis, value: unknown): string[] {
    // `agent` is handled by Agents(), which resolves registry refs as well as
    // paths. This check is for the axes that can only ever be local.
    if (axis.key !== "cognet") return []
    return typeof value === "string" ? [value] : []
}

export function PrepareBench(opts: { root: string; discover: DiscoverT; typegen: BenchTypegenT; agents: AgentsT }) {
    return async function prepare(): Promise<BenchPrepareResult> {
        const config = await opts.discover.load()
        const tests = await resolveTestFiles(config.tests, opts.root)
        if (tests.length === 0) throw err("BENCH_TESTS_NOT_FOUND", { detail: config.tests.join(", "), context: { declared: config.tests } })
        for (const axis of config.axes) {
            for (const variation of axis.values) {
                for (const ref of localRefs(axis, variation.value)) {
                    if (!ref.startsWith(".") && !isAbsolute(ref)) continue
                    const path = isAbsolute(ref) ? ref : resolve(opts.root, ref)
                    if (!fsx.exists(path)) throw err("BENCH_LOCAL_REF_NOT_FOUND", { detail: `${axis.key}/${variation.id} -> ${ref}`, context: { axis: axis.key, valueId: variation.id, ref } })
                }
            }
        }
        // Fetch registry agents and prepare every agent the matrix names —
        // local or cloned. A freshly cloned agent has no node_modules and no
        // generated types, so without this every cell fails at boot with an
        // error that says nothing about the cause.
        const agents = await opts.agents.resolve(config.axes)

        const workspace = await Workspace({ root: opts.root, definition: config.workspace }).prepare()
        return {
            typegen: await opts.typegen.write(config),
            tests,
            workspace: workspace.template,
            agents: [...agents.values()].map(agent => ({ ref: agent.ref, pin: agent.pin })),
            warnings: [],
        }
    }
}

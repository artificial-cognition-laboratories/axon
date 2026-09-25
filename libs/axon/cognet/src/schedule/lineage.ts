import { err } from "@arcforge/err"
import type { SchemaT } from "../ecs"
import type { LineageEntry, SystemSpec } from "./types"

export type LineageOpts = {
    schema: SchemaT
    systems: readonly SystemSpec<any>[]
}

/**
 * Lineage — the schedule's data graph: which system produces and consumes
 * which belief.
 *
 * This is what a reader reaches for instead of a call graph. It is also what
 * is checked before the first run, because the two ways it can be wrong are
 * both silent forever at runtime: a mistyped component name reads `undefined`
 * for the life of the process, and a belief nothing writes makes its reader
 * quietly do nothing.
 */
export function Lineage(opts: LineageOpts) {
    const { schema, systems } = opts

    return {
        /** Throws COGNET_SCHEDULE_INVALID naming every incoherent claim at once. */
        check(): void {
            const problems = [...undeclared({ schema: schema, systems: systems }), ...orphaned(systems)]
            if (problems.length === 0) return
            throw err("COGNET_SCHEDULE_INVALID", { detail: problems.join("; ") })
        },

        /** For each belief any system names: its producers and consumers, in schedule order. */
        graph(): LineageEntry[] {
            const components = new Set(systems.flatMap(spec => [...spec.reads, ...spec.writes]))

            return [...components].sort().map(component => ({
                component: component,
                writtenBy: systems.filter(spec => spec.writes.includes(component)).map(spec => spec.name),
                readBy: systems.filter(spec => spec.reads.includes(component)).map(spec => spec.name),
            }))
        },

        /** The schedule as data — the `cognet:schedule:declare` payload. */
        declaration() {
            return {
                systems: systems.map(spec => ({
                    name: spec.name,
                    phase: spec.phase,
                    everyMs: spec.everyMs,
                    reads: [...spec.reads],
                    writes: [...spec.writes],
                })),
            }
        },
    }
}

export type LineageT = ReturnType<typeof Lineage>

function undeclared(opts: LineageOpts): string[] {
    return opts.systems.flatMap(spec =>
        [...spec.reads, ...spec.writes]
            .filter(component => !opts.schema.get(component))
            .map(component => `${spec.name} names "${component}", which the world has not declared`),
    )
}

function orphaned(systems: readonly SystemSpec<any>[]): string[] {
    const produced = new Set(systems.flatMap(spec => [...spec.writes]))
    return systems.flatMap(spec =>
        spec.reads
            .filter(component => !produced.has(component))
            .map(component => `${spec.name} reads "${component}", which no system writes`),
    )
}

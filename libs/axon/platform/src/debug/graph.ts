import { err } from "@arcforge/err"
import type { Declaration } from "./types"

type System = Declaration["systems"][number]

/** One step of a walk: a system reached, through which component, and how — read, run by it (`on`), or recalled, which crosses a tick. */
export type Reached = { system: string; through: string; edge: "reads" | "streams" | "runs" | "recalls"; depth: number }

/**
 * Graph — who reads and writes what, and what follows from it.
 *
 * Answers from a mind's own declaration: the systems in run order, and for
 * each the components it reads this tick, streams, is run by (`on`), recalls
 * from the last, and writes. An edge runs from a system that writes a
 * component to one that reads it, streams it, is run by it, or recalls it.
 */
export function Graph() {
    return {
        /** A system by its full name, or by the end of it when only one ends that way. */
        system(declared: Declaration, ref: string): System {
            const name = names.find(declared.systems.map(system => system.name), ref, "system")
            return declared.systems.find(system => system.name === name)!
        },

        /** A component: its flags, who writes it, who reads it, who streams it, whom it runs and who recalls it. */
        component(declared: Declaration, ref: string) {
            const name = names.find(declared.components.map(component => component.name), ref, "component")
            const touching = (list: "reads" | "streams" | "recalls" | "writes") => declared.systems.filter(system => (system[list] ?? []).includes(name)).map(system => system.name)
            const runs = declared.systems.filter(system => (system.on ?? []).includes(name)).map(system => system.name)
            return { ...declared.components.find(component => component.name === name)!, writtenBy: touching("writes"), readBy: touching("reads"), streamedBy: touching("streams"), runs: runs, recalledBy: touching("recalls") }
        },

        /**
         * Every system a change in `from` can reach (`downstream`), or every
         * system it depends on (`upstream`), nearest first, each once — by
         * the shortest way to it. `depth` bounds how far.
         */
        walk(declared: Declaration, from: string, direction: "downstream" | "upstream", depth: number): Reached[] {
            const reached: Reached[] = []
            const seen = new Set<string>([from])
            let frontier = [from]
            for (let level = 1; level <= depth && frontier.length > 0; level++) {
                const next: string[] = []
                for (const name of frontier) {
                    const system = declared.systems.find(candidate => candidate.name === name)!
                    for (const step of direction === "downstream" ? steps.after(declared, system) : steps.before(declared, system)) {
                        if (seen.has(step.system)) continue
                        seen.add(step.system)
                        reached.push({ ...step, depth: level })
                        next.push(step.system)
                    }
                }
                frontier = next
            }
            return reached
        },
    }
}

export type GraphT = ReturnType<typeof Graph>

const steps = {
    /** The systems that take in what `system` writes. */
    after(declared: Declaration, system: System): Array<Omit<Reached, "depth">> {
        return system.writes.flatMap(component => declared.systems.flatMap(other => [
            ...(other.reads.includes(component) ? [{ system: other.name, through: component, edge: "reads" as const }] : []),
            ...((other.streams ?? []).includes(component) ? [{ system: other.name, through: component, edge: "streams" as const }] : []),
            ...((other.on ?? []).includes(component) ? [{ system: other.name, through: component, edge: "runs" as const }] : []),
            ...(other.recalls.includes(component) ? [{ system: other.name, through: component, edge: "recalls" as const }] : []),
        ]))
    },

    /** The systems that write what `system` takes in. */
    before(declared: Declaration, system: System): Array<Omit<Reached, "depth">> {
        const taken = [
            ...system.reads.map(component => ({ component: component, edge: "reads" as const })),
            ...(system.streams ?? []).map(component => ({ component: component, edge: "streams" as const })),
            ...(system.on ?? []).map(component => ({ component: component, edge: "runs" as const })),
            ...system.recalls.map(component => ({ component: component, edge: "recalls" as const })),
        ]
        return taken.flatMap(input => declared.systems.filter(other => other.writes.includes(input.component)).map(other => ({ system: other.name, through: input.component, edge: input.edge })))
    },
}

const names = {
    /** The one name `ref` means: itself, or the only one ending in `/ref`. */
    find(all: string[], ref: string, what: string): string {
        if (all.includes(ref)) return ref
        const ending = all.filter(name => name.endsWith(`/${ref}`))
        if (ending.length === 1) return ending[0]!
        if (ending.length === 0) throw err("DEBUG_UNKNOWN_NAME", { detail: `no ${what} is named "${ref}"` })
        throw err("DEBUG_AMBIGUOUS", { detail: `"${ref}" names ${ending.length} ${what}s: ${ending.join(", ")}` })
    },
}

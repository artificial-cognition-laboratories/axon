import { err } from "@arcforge/err"
import { definitions, type Component, type Definition, type Query, type QueryShape } from "../ecs"
import { systems as registry } from "./system"
import { clock, stimuli } from "./input"
import type { LineageEntry, NamedSystem, Readable } from "./types"

export type LineageOpts = {
    systems: readonly NamedSystem[]
    /** The mind's clock, for a continuous mind — declared to readers, nothing more. */
    hz?: number
    /** The uses cognet.config.ts declares — every system's `uses` must be among them. */
    uses?: readonly string[]
}

/**
 * Lineage — the schedule's data graph, and everything derived from it.
 *
 * An ECS has no call graph, so this is what a reader reaches for instead: who
 * writes each component, who reads it. It is also the ORDER — a writer runs
 * before its readers — and the checks that make the order trustworthy.
 *
 * Every check is here and pure, so the same rules can run wherever a schedule
 * is assembled, and a test can assert them with no world.
 */
export function Lineage(opts: LineageOpts) {
    const systems = [...opts.systems].sort((a, b) => compare(a.name, b.name))

    function order(): NamedSystem[] {
        const result = ordering.sort(systems)
        if (result.cycle) throw err("COGNET_SCHEDULE_INVALID", { detail: `systems form a cycle: ${result.cycle.join(" → ")}` })
        return result.order
    }

    return {
        /**
         * Throws COGNET_SCHEDULE_INVALID naming every problem at once: writers,
         * orphans, triggers, threads, lag, cycles. Each is silent or nondeterministic at
         * runtime, so the schedule refuses to run instead.
         */
        check(): void {
            const problems = [
                ...rules.duplicates(systems),
                ...rules.writers(systems),
                ...rules.orphans(systems),
                ...rules.triggers(systems, opts.hz),
                ...rules.threads(systems),
                ...rules.lag(systems, opts.hz),
                ...rules.uses(systems, opts.uses ?? []),
            ]
            if (problems.length === 0) {
                // Only meaningful once the edges are known to be legal.
                const cycle = ordering.sort(systems).cycle
                if (cycle) problems.push(`systems form a cycle: ${cycle.join(" → ")} — declare one of those reads as \`recalls\``)
            }
            if (problems.length === 0) return
            throw err("COGNET_SCHEDULE_INVALID", { detail: problems.join("; ") })
        },

        /** Every system, writers before readers, ties broken by name. Call after check(). */
        order: order,

        /**
         * For each system, the systems before it in `order()` it must not
         * overlap: one writes what the other reads or recalls. Everything
         * else may run at the same time and compute exactly what running in
         * order would — neither can see the other. Call after check().
         */
        waits(): Map<string, string[]> {
            return ordering.waits(order())
        },

        /** For each component any system names: its producers and consumers. */
        graph(): LineageEntry[] {
            return touched.all(systems).map(component => ({
                component: component.name,
                writtenBy: systems.filter(entry => touched.writes(entry).includes(component)).map(entry => entry.name),
                readBy: systems.filter(entry => touched.reads(entry).includes(component)).map(entry => entry.name),
                streamedBy: systems.filter(entry => touched.streams(entry).includes(component)).map(entry => entry.name),
                runs: systems.filter(entry => touched.triggers(entry).includes(component)).map(entry => entry.name),
                recalledBy: systems.filter(entry => touched.recalls(entry).includes(component)).map(entry => entry.name),
            }))
        },

        /** The `cognet:schedule:declare` payload. */
        declaration() {
            const queries = new Set<Query<QueryShape>>()
            for (const entry of systems) {
                for (const definition of [...(entry.system.reads ?? []), ...(entry.system.recalls ?? [])]) {
                    if (definition.kind === "query") queries.add(definition)
                }
            }

            return {
                /** Null for a reactive mind, which has no fixed tick deadline. */
                hz: opts.hz ?? null,
                systems: ordering.sort(systems).order.map(entry => ({
                    name: entry.name,
                    /** What runs it, when it names it; null: what it reads does. */
                    on: entry.system.on ? entry.system.on.map(definition => definition.name) : null,
                    once: entry.system.once ?? false,
                    async: registry.async(entry.system),
                    worker: entry.system.thread === "worker",
                    lag: entry.system.lag ?? 0,
                    reads: (entry.system.reads ?? []).map(definition => definition.name),
                    streams: (entry.system.streams ?? []).map(definition => definition.name),
                    recalls: (entry.system.recalls ?? []).map(definition => definition.name),
                    writes: (entry.system.writes ?? []).map(definition => definition.name),
                    uses: [...(entry.system.uses ?? [])],
                })),
                components: touched.all(systems).map(component => ({
                    name: component.name,
                    scope: component.scope,
                })),
                queries: [...queries].sort((a, b) => compare(a.name, b.name)).map(query => ({
                    name: query.name,
                    scope: query.scope,
                    members: Object.values(query.shape).map(component => component.name),
                })),
            }
        },

        /** Every component any system names, for declaring to readers. */
        components(): Component<any>[] {
            return touched.all(systems)
        },
    }
}

export type LineageT = ReturnType<typeof Lineage>

// ── what a system touches ───────────────────────────────────────────────────

const touched = {
    /** Components read this tick — queries expanded, plus their exclusions. */
    reads(entry: NamedSystem): Component<any>[] {
        return touched.expand(entry.system.reads ?? [])
    },

    recalls(entry: NamedSystem): Component<any>[] {
        return touched.expand(entry.system.recalls ?? [])
    },

    /** Components read as every value written since the system last ran. */
    streams(entry: NamedSystem): Component<any>[] {
        return [...(entry.system.streams ?? [])]
    },

    /** What the system's writes are to the tick it runs in: nothing, when they land in a later one. */
    landing(entry: NamedSystem): Component<any>[] {
        return lands.later(entry) ? [] : touched.writes(entry)
    },

    writes(entry: NamedSystem): Component<any>[] {
        return [...(entry.system.writes ?? [])]
    },

    /** Components named in `on` — what runs it, and, like a read, what orders it after its writer. */
    triggers(entry: NamedSystem): Component<any>[] {
        return touched.expand(entry.system.on ?? [])
    },

    /** The components a list touches. Inputs are not components, and have no writer to order against. */
    expand(list: readonly Readable[]): Component<any>[] {
        const out = new Set<Component<any>>()
        for (const definition of list) {
            if (definition.kind === "input") continue
            for (const member of definitions.members(definition)) out.add(member)
            if (definition.kind === "query") for (const excluded of definition.opts.without ?? []) out.add(excluded)
        }
        return [...out]
    },

    /** Every component any system names, by name. */
    all(systems: readonly NamedSystem[]): Component<any>[] {
        const all = new Set<Component<any>>()
        for (const entry of systems) {
            for (const component of [...touched.reads(entry), ...touched.streams(entry), ...touched.triggers(entry), ...touched.recalls(entry), ...touched.writes(entry)]) all.add(component)
        }
        return [...all].sort((a, b) => compare(a.name, b.name))
    },
}

// ── the rules ───────────────────────────────────────────────────────────────

const rules = {
    duplicates(systems: readonly NamedSystem[]): string[] {
        const seen = new Set<string>()
        const problems: string[] = []
        for (const entry of systems) {
            if (seen.has(entry.name)) problems.push(`two systems are named "${entry.name}"`)
            seen.add(entry.name)
        }
        return problems
    },

    /** One writer per component: every belief has one answer to where it came from. */
    writers(systems: readonly NamedSystem[]): string[] {
        const problems: string[] = []
        for (const component of touched.all(systems)) {
            const by = systems.filter(entry => touched.writes(entry).includes(component)).map(entry => entry.name)
            if (by.length > 1) problems.push(`"${component.name}" is written by ${by.join(" and ")} — one writer per component`)
        }
        return problems
    },

    /** A component read that nothing writes would read `undefined` forever; one that runs a system, and nothing writes, would never run it. */
    orphans(systems: readonly NamedSystem[]): string[] {
        const written = new Set(systems.flatMap(touched.writes))
        const problems: string[] = []
        for (const entry of systems) {
            for (const component of [...touched.reads(entry), ...touched.recalls(entry)]) {
                if (!written.has(component)) problems.push(`${entry.name} reads "${component.name}", which no system writes`)
            }
            for (const component of touched.streams(entry)) {
                if (!written.has(component)) problems.push(`${entry.name} streams "${component.name}", which no system writes — it would never hold a value`)
            }
            for (const component of touched.triggers(entry)) {
                if (!written.has(component)) problems.push(`${entry.name} is run by "${component.name}", which no system writes — it would never run`)
            }
        }
        return problems
    },

    /**
     * What runs a system must be able to. The clock is no data — nothing
     * reads it — so it is named only in `on`. Stimuli run a system only if it
     * takes them. And a system nothing runs — no reads, no `on` — would run
     * on its first tick and never again: that is `once`, said plainly, or
     * `on: [clock]`. A mind with no clock ticks each wake until its async
     * work settles; an async system the clock runs starts again every tick,
     * so that wake would never fall quiet.
     */
    triggers(systems: readonly NamedSystem[], hz: number | undefined): string[] {
        const problems: string[] = []
        for (const entry of systems) {
            const spec = entry.system
            if (hz === undefined && (spec.on ?? []).includes(clock) && registry.async(spec)) problems.push(`${entry.name} is async and run by the clock in a mind with no clock — each wake waits for its async work, which would start again every tick and never let the wake end`)
            if ([...(spec.reads ?? []), ...(spec.recalls ?? [])].includes(clock)) problems.push(`${entry.name} reads the clock — it carries nothing to read; name it in \`on\` to run every tick`)
            if ((spec.on ?? []).includes(stimuli) && !(spec.reads ?? []).includes(stimuli)) problems.push(`${entry.name} is run by stimuli it does not read — add \`stimuli\` to its reads`)
            if (spec.on && spec.on.length === 0) problems.push(`${entry.name} has \`on: []\` — nothing would ever run it`)
            const runs = spec.on ?? [...(spec.reads ?? []), ...(spec.streams ?? [])]
            if (runs.length === 0 && !spec.once) problems.push(`${entry.name} reads nothing and names nothing in \`on\` — it would run once and never again; say \`once: true\`, or \`on: [clock]\` to run every tick`)
        }
        return problems
    },

    /**
     * A worker system is synchronous and reads only the world. An async run
     * awaits the kernel — engines, the store — which lives on the main
     * thread; a run that read stimuli would have them copied across for
     * nothing a main-thread system could not do as cheaply.
     */
    threads(systems: readonly NamedSystem[]): string[] {
        const problems: string[] = []
        for (const entry of systems) {
            if (entry.system.thread !== "worker") continue
            if (registry.async(entry.system)) problems.push(`${entry.name} is \`async\` and \`thread: "worker"\` — a worker run is synchronous; the kernel it would await is on the main thread`)
            if ((entry.system.reads ?? []).some(definition => definition.kind === "input")) problems.push(`${entry.name} reads stimuli on a worker thread — read them on the main thread and write what the worker needs`)
            if ((entry.system.uses ?? []).length > 0) problems.push(`${entry.name} uses services on a worker thread — the kernel that serves them is on the main thread`)
        }
        return problems
    },

    /** A system reaches only uses the cognet declares, each named once. */
    uses(systems: readonly NamedSystem[], declared: readonly string[]): string[] {
        const problems: string[] = []
        for (const entry of systems) {
            const uses = entry.system.uses ?? []
            for (const use of new Set(uses)) {
                if (!declared.includes(use)) problems.push(`${entry.name} uses "${use}", which cognet.config.ts does not declare in uses`)
            }
            if (new Set(uses).size !== uses.length) problems.push(`${entry.name} names a use twice`)
        }
        return problems
    },

    /**
     * A lag is a whole number of ticks of the mind's clock — the tick its
     * writes land in is counted, never timed, which is what keeps a lagged
     * run the same live and replayed. A mind with no clock ticks only until
     * its work has landed, so there a lag counts nothing but ticks made to
     * land it — and a lagged system something writes every tick would keep
     * that wake ticking forever. An async system already lands when it is
     * done; a lag on it would say two different things about when.
     */
    lag(systems: readonly NamedSystem[], hz: number | undefined): string[] {
        const problems: string[] = []
        for (const entry of systems) {
            const lag = entry.system.lag
            if (lag === undefined) continue
            if (!Number.isInteger(lag) || lag < 0) problems.push(`${entry.name} has \`lag: ${lag}\` — a lag is a whole number of ticks`)
            else if (lag > 0 && registry.async(entry.system)) problems.push(`${entry.name} is \`async\` and has \`lag: ${lag}\` — an async run lands when it is done; a lagged one lands ${lag} ticks after it starts. Say one`)
            else if (lag > 0 && hz === undefined) problems.push(`${entry.name} has \`lag: ${lag}\` in a mind with no clock — a lag counts the ticks of a clock; run it in its tick, or make it \`async\``)
        }
        return problems
    },
}

/** When a system's writes land — private to the lineage. */
const lands = {
    /** Whether they land in a later tick than the one it runs in: async, or lagged. */
    later(entry: NamedSystem): boolean {
        return registry.async(entry.system) || (entry.system.lag ?? 0) > 0
    },
}

// ── the order ───────────────────────────────────────────────────────────────

const ordering = {
    /**
     * Writers before readers — Kahn's algorithm with the ready set kept sorted
     * by name, so the order depends on the data alone and never on discovery
     * order.
     *
     * A trigger (`on`) orders like a read, and so does a stream. `recalls`
     * add no edge, and neither does a system reading what it writes.
     * Neither does the write of an ASYNC or LAGGED system: it lands at the
     * start of a later tick, before every system, so no order within a tick
     * can matter to it.
     * What is left and still cyclic is returned as the cycle.
     */
    sort(systems: readonly NamedSystem[]): { order: NamedSystem[]; cycle: string[] | null } {
        const after = new Map<string, Set<string>>(systems.map(entry => [entry.name, new Set()]))
        const waiting = new Map<string, number>(systems.map(entry => [entry.name, 0]))

        for (const reader of systems) {
            for (const component of [...touched.reads(reader), ...touched.streams(reader), ...touched.triggers(reader)]) {
                for (const writer of systems) {
                    if (writer === reader || !touched.landing(writer).includes(component)) continue
                    const edges = after.get(writer.name)!
                    if (edges.has(reader.name)) continue
                    edges.add(reader.name)
                    waiting.set(reader.name, waiting.get(reader.name)! + 1)
                }
            }
        }

        const byName = new Map(systems.map(entry => [entry.name, entry]))
        const ready = systems.filter(entry => waiting.get(entry.name) === 0).map(entry => entry.name)
        const result: NamedSystem[] = []

        while (ready.length > 0) {
            ready.sort(compare)
            const next = ready.shift()!
            result.push(byName.get(next)!)
            for (const reader of after.get(next)!) {
                const left = waiting.get(reader)! - 1
                waiting.set(reader, left)
                if (left === 0) ready.push(reader)
            }
        }

        if (result.length === systems.length) return { order: result, cycle: null }
        return { order: result, cycle: ordering.cycle(after, new Set(result.map(entry => entry.name))) }
    },

    /**
     * The conflicts in a total order. Order is still the order: a system
     * waits only for earlier ones, so every pair that could see each other
     * keeps the order Kahn chose, and the rest of the edges were never there.
     *
     * A recall conflicts too. Which tick's value a recaller sees is fixed by
     * the order — before its writer, last tick's; after, this tick's — and
     * overlapping them would leave it to timing.
     *
     * A system whose writes land in a later tick writes nothing here, so
     * nothing waits for its writes. What waits for IT is a later writer of
     * what it reads — and that waits only for it to START: it reads a
     * snapshot taken then.
     */
    waits(order: readonly NamedSystem[]): Map<string, string[]> {
        const sees = order.map(entry => new Set([...touched.reads(entry), ...touched.streams(entry), ...touched.triggers(entry), ...touched.recalls(entry)]))
        const writes = order.map(entry => touched.landing(entry))
        const result = new Map<string, string[]>()
        order.forEach((entry, index) => {
            const before: string[] = []
            for (let earlier = 0; earlier < index; earlier++) {
                const conflict = writes[earlier]!.some(component => sees[index]!.has(component))
                    || writes[index]!.some(component => sees[earlier]!.has(component))
                if (conflict) before.push(order[earlier]!.name)
            }
            result.set(entry.name, before)
        })
        return result
    },

    /**
     * One cycle among the systems that never became ready, as a path that
     * returns to its start.
     *
     * Walked BACKWARD, along what each system waits on. A stuck system may
     * only be downstream of a cycle, with nothing stuck after it — walking
     * forward from it finds no cycle at all. But every stuck system is
     * waiting on at least one stuck system, so walking back always closes.
     */
    cycle(after: Map<string, Set<string>>, done: Set<string>): string[] {
        const before = new Map<string, string[]>()
        for (const [writer, readers] of after) {
            if (done.has(writer)) continue
            for (const reader of readers) if (!done.has(reader)) before.set(reader, [...(before.get(reader) ?? []), writer])
        }
        const start = [...before.keys()].sort(compare)[0]!
        const path = [start]
        const seen = new Set([start])
        let at = start
        while (true) {
            const previous = before.get(at)!.sort(compare)[0]!
            if (seen.has(previous)) {
                // The walk ran backward; the cycle reads forward, writer before reader.
                const loop = path.slice(path.indexOf(previous)).reverse()
                // Started at its first member by name, so a cycle reads the same however it was found.
                const first = loop.indexOf([...loop].sort(compare)[0]!)
                const turned = [...loop.slice(first), ...loop.slice(0, first)]
                return [...turned, turned[0]!]
            }
            path.push(previous)
            seen.add(previous)
            at = previous
        }
    },
}

function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

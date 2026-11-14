import type { AxonStimulusEntry } from "@arcforge/types"
import { err } from "@arcforge/err"
import { definitions, type Component, type Written } from "../ecs"
import { clock, stimuli } from "./input"
import type { NamedSystem, Run } from "./types"
import type { RunServices } from "../services"

/**
 * What a run is handed of each component it streams, by name. Held untyped,
 * as the world holds every value: the handle a system asks with types it.
 */
export type Streamed = ReadonlyMap<string, readonly Written<any>[]>

/** What a system may touch, and what happens when it touches anything else. */
export const access = {
    /** Whether a system names this input in its reads. */
    reads(entry: NamedSystem, input: typeof stimuli): boolean {
        return (entry.system.reads ?? []).includes(input)
    },

    /**
     * What runs a system, when it changes: its `on`, else its reads and
     * streams — component names, streamed component names (a write since it
     * last ran, even one that changed nothing), and whether new stimuli or
     * the passing of time do. Recalls never run anything: they are last
     * tick's values, and a loop that ran on its own feedback would never be
     * still.
     */
    triggers(entry: NamedSystem): { components: Set<string>; streams: Set<string>; stimuli: boolean; clock: boolean } {
        const list = entry.system.on ?? entry.system.reads ?? []
        const components = new Set<string>()
        for (const definition of list) {
            if (definition.kind === "input") continue
            for (const member of definitions.members(definition)) components.add(member.name)
        }
        const streams = entry.system.on ? new Set<string>() : access.streamed(entry)
        return { components: components, streams: streams, stimuli: list.includes(stimuli), clock: list.includes(clock) }
    },

    /** The components a system streams, by name. */
    streamed(entry: NamedSystem): Set<string> {
        return new Set((entry.system.streams ?? []).map(component => component.name))
    },

    /** Component names a run may read: its reads, recalls and writes. */
    readable(entry: NamedSystem): Set<string> {
        const names = new Set<string>()
        for (const definition of [...(entry.system.reads ?? []), ...(entry.system.recalls ?? [])]) {
            if (definition.kind === "input") continue
            for (const member of definitions.members(definition)) names.add(member.name)
            if (definition.kind === "query") for (const excluded of definition.opts.without ?? []) names.add(excluded.name)
        }
        for (const component of entry.system.writes ?? []) names.add(component.name)
        return names
    },

    /** Where each consumed stimulus sits in the log — its seq — and which channel it came in on. */
    inputs(entries: readonly AxonStimulusEntry[]): Array<{ seq: number; channel: string }> {
        return entries.map(entry => ({ seq: entry.time.seq, channel: entry.data.channel }))
    },

    /** Component names a run may write. */
    writable(entry: NamedSystem): Set<string> {
        return new Set((entry.system.writes ?? []).map(component => component.name))
    },

    /**
     * The run a system is handed: the tick's time and signal, its stimuli
     * when it reads them, and what it streams. Asking for stimuli or a
     * stream it did not declare throws.
     */
    run(system: string, given: { now: number; signal: AbortSignal; stimuli: readonly AxonStimulusEntry[] | null; streams: Streamed; services: RunServices }): Run {
        return {
            now: given.now,
            signal: given.signal,
            services: given.services,
            get stimuli(): readonly AxonStimulusEntry[] {
                if (given.stimuli === null) throw err("COGNET_UNDECLARED_ACCESS", { detail: `${system} read stimuli without declaring \`reads: [stimuli]\`` })
                return given.stimuli
            },
            since: <T>(handle: Component<T>): readonly Written<T>[] => {
                const found = given.streams.get(handle.name)
                if (!found) throw err("COGNET_UNDECLARED_ACCESS", { detail: `${system} asked for every write to "${handle.name}" without declaring it in streams` })
                return found
            },
        }
    },

    /** Throws when a sync run touched a component its declaration does not cover. */
    enforce(entry: NamedSystem, observed: { looked: string[]; writes: Array<{ component: string }> }): void {
        const readable = access.readable(entry)
        const writable = access.writable(entry)

        for (const component of observed.looked) {
            if (readable.has(component)) continue
            throw err("COGNET_UNDECLARED_ACCESS", { detail: `${entry.name} read "${component}" without declaring it in reads or recalls` })
        }
        for (const write of observed.writes) {
            if (writable.has(write.component)) continue
            throw err("COGNET_UNDECLARED_ACCESS", { detail: `${entry.name} wrote "${write.component}" without declaring it in writes` })
        }
    },
}

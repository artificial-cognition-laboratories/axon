import type { EcsT, Read, Written } from "../ecs"
import type { Streamed } from "./access"
import type { NamedSystem } from "./types"

/**
 * Cursors — where each system that streams a component has got to in the
 * world's history of it (see ecs History).
 *
 * A system takes everything written since it last took, and is then at the
 * history's newest write. History is kept only for streamed components, from
 * the first tick, and let go once every system streaming it has taken it — a
 * system that has had its one run (`once`) no longer holds any back.
 */
export function Cursors(opts: { ecs: EcsT; systems: readonly NamedSystem[] }) {
    const { history } = opts.ecs.state
    /** Each streaming system's place: the history's mark when it last took. */
    const places = new Map<string, number>()
    /** Each streamed component, and the systems streaming it. */
    const readers = new Map<string, string[]>()
    for (const entry of opts.systems) {
        for (const component of entry.system.streams ?? []) readers.set(component.name, [...(readers.get(component.name) ?? []), entry.name])
    }

    return {
        /** Keep every write to each streamed component from now on. Called as the first tick begins. */
        keep(): void {
            for (const component of readers.keys()) history.keep(component)
        },

        /** Whether anything `entry` streams has been written since it last took. */
        waiting(entry: NamedSystem): boolean {
            const place = places.get(entry.name) ?? 0
            return (entry.system.streams ?? []).some(component => history.waiting(component.name, place))
        },

        /**
         * Everything `entry` streams, written since it last took, by
         * component — and what was handed, as the reads the run record
         * carries. It has taken it all.
         */
        take(entry: NamedSystem): { streams: Streamed; handed: Read[] } {
            const place = places.get(entry.name) ?? 0
            const streams = new Map<string, readonly Written<any>[]>()
            const handed = new Map<string, Read>()
            for (const component of entry.system.streams ?? []) {
                const written = history.since(component.name, place)
                streams.set(component.name, written)
                for (const one of written) handed.set(`${one.entity}\0${component.name}\0${one.rev}`, { entity: one.entity, component: component.name, rev: one.rev })
            }
            if (streams.size > 0) places.set(entry.name, history.mark())
            return { streams: streams, handed: [...handed.values()] }
        },

        /** Let go of every write each streamed component's readers have all taken; `spent` systems — `once`, and run — hold nothing back. */
        trim(spent: ReadonlySet<string>): void {
            for (const [component, systems] of readers) {
                const holding = systems.filter(name => !spent.has(name))
                if (holding.length === 0) {
                    history.trim(component, history.mark())
                    continue
                }
                history.trim(component, Math.min(...holding.map(name => places.get(name) ?? 0)))
            }
        },
    }
}

export type CursorsT = ReturnType<typeof Cursors>

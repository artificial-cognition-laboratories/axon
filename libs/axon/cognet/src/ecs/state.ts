import { definitions, type Component } from "./handle"
import { History } from "./history"
import type { ComponentStore, ComponentWatcher, EntityId, QueryObservation, Read, Stamp, Write } from "./types"

export type StateOpts = {
    /** The clock's stamp — world mutations are attributed to a tick, phase and system. */
    stamp(): Stamp
    /** Wall clock, for the write time carried with every component. */
    now(): number
}

/**
 * State — the single owner of everything shared inside the world: entity set,
 * component stores, watchers, and the observation in progress. Component() and
 * Entity() are views over this; nothing else holds the maps.
 *
 * Stores are keyed by component NAME. Handles are the authoring surface; the
 * name is what the log, the lineage and the store agree on.
 */
export function State(opts: StateOpts) {
    const entities = new Set<EntityId>()
    const components = new Map<string, ComponentStore>()
    const watchers = new Map<string, Set<ComponentWatcher>>()
    /** The rev of each component's most recent CHANGE — set, update or removal. */
    const changes = new Map<string, number>()
    let revs = 0
    /** What the current observation has seen. Null when nobody is observing. */
    let observed: { reads: Map<string, Read>; writes: Map<string, Write>; looked: Set<string>; queries: QueryObservation[] } | null = null

    function record(component: string, entity: EntityId, rev: number): void {
        if (!observed) return
        observed.reads.set(`${entity}\0${component}`, { entity: entity, component: component, rev: rev })
    }

    /**
     * Note that a component was looked at, whether or not a value was there.
     * Separate from record(): a read that found nothing has no rev to be a
     * causal parent, but it is still an access — and enforcement that only
     * saw successful reads would pass or fail depending on timing.
     */
    function look(component: string): void {
        observed?.looked.add(component)
    }

    /** Every write to a streamed component, until each reader has taken it. */
    const history = History()

    return {
        entities: entities,
        components: components,
        history: history,

        /** The next change id. World-monotonic, so a rev names one change uniquely. */
        nextRev(): number {
            revs += 1
            return revs
        },

        /** The latest rev handed out — a point in the world's history to compare against. */
        rev(): number {
            return revs
        },

        /** Record that a component changed, at this rev. */
        changed(component: string, rev: number): void {
            changes.set(component, rev)
        },

        /** Whether a component has changed since a point in the world's history. */
        changedSince(component: string, rev: number): boolean {
            return (changes.get(component) ?? 0) > rev
        },

        /** Note that a value was read, if a run is being observed. */
        record: record,

        /** Note that a component was accessed, found or not. */
        look: look,

        /** Record a query's final matches after its predicates have run. */
        query(input: { required: string[]; optional: string[]; where?: unknown; filtered: boolean; candidates: number; rows: readonly Entry[] }): void {
            if (!observed) return
            const names = [...input.required, ...input.optional]
            observed.queries.push({
                ordinal: observed.queries.length,
                required: input.required,
                optional: input.optional,
                ...(input.where === undefined ? {} : { where: input.where }),
                filtered: input.filtered,
                candidates: input.candidates,
                count: input.rows.length,
                matched: input.rows.slice(0, 24).map(row => ({
                    entity: row.id,
                    values: names.flatMap(component => {
                        const rev = row.meta[definitions.key(definitions.find(component))]?.rev
                        return rev === undefined ? [] : [{ entity: row.id, component: component, rev: rev }]
                    }),
                })),
            })
        },

        /** Note that a value was written, if a run is being observed. */
        wrote(component: string, entity: EntityId): void {
            if (!observed) return
            observed.writes.set(`${entity}\0${component}`, { entity: entity, component: component })
        },

        /**
         * Runs `fn` and returns every value it read, every write it made, and
         * every component it looked at — found or not.
         *
         * Synchronous on purpose: a system run is, and an observation that
         * spanned an await would attribute another caller's accesses to this
         * one. Not re-entrant for the same reason.
         */
        observe<T>(fn: () => T): { result: T; reads: Read[]; writes: Write[]; looked: string[]; queries: QueryObservation[] } {
            if (observed) throw new Error("ecs.observe() is already recording — a nested observation would mix two runs' accesses")
            observed = { reads: new Map(), writes: new Map(), looked: new Set(), queries: [] }
            try {
                const result = fn()
                return {
                    result: result,
                    reads: [...observed.reads.values()],
                    writes: [...observed.writes.values()],
                    looked: [...observed.looked],
                    queries: observed.queries,
                }
            } finally {
                observed = null
            }
        },

        /** An isolated async run owns this private snapshot until its promise settles. */
        async observeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; reads: Read[]; writes: Write[]; looked: string[]; queries: QueryObservation[] }> {
            if (observed) throw new Error("ecs.observeAsync() is already recording")
            observed = { reads: new Map(), writes: new Map(), looked: new Set(), queries: [] }
            try {
                const result = await fn()
                return { result: result, reads: [...observed.reads.values()], writes: [...observed.writes.values()], looked: [...observed.looked], queries: observed.queries }
            } finally {
                observed = null
            }
        },

        /** tick/phase/system stamp merged into every world event payload. */
        stamp: opts.stamp,

        /** Wall clock at the moment of a write. */
        now: opts.now,

        /** Subscribe to writes on one component. Returns an unsubscribe function. */
        watch(component: Component<any>, handler: ComponentWatcher): () => void {
            let set = watchers.get(component.name)
            if (!set) {
                set = new Set()
                watchers.set(component.name, set)
            }
            set.add(handler)
            return () => {
                watchers.get(component.name)?.delete(handler)
            }
        },

        /** Fire watchers for a component write. A throwing watcher is a bug — it propagates. */
        notify(component: string, entity: EntityId, data: unknown): void {
            const set = watchers.get(component)
            if (!set) return
            for (const watcher of set) watcher(entity, data)
        },

        /**
         * Every entity holding all of `members`, one object each, in entity
         * order: its `id`, each component's value under the component's
         * export name, and under `meta` when each was written. An `optional`
         * component is there when the entity holds it and undefined when it
         * does not. Each value returned is recorded as read.
         */
        rows(members: readonly Component<any>[], optional: readonly Component<any>[] = []): Entry[] {
            if (members.length === 0) throw new Error("a query names no components — `optional` adds to the entities `components` finds")
            const every = [...members, ...optional]
            const keys = every.map(member => definitions.key(member))
            if (new Set(keys).size !== keys.length) throw new Error(`a query names two components called the same — ${every.map(member => member.name).join(", ")} — and a row has one value under each name`)
            for (const member of every) look(member.name)

            const stores: ComponentStore[] = []
            for (const member of members) {
                const store = components.get(member.name)
                if (!store) return []
                stores.push(store)
            }

            // Intersect from the smallest store.
            const [smallest, ...rest] = [...stores].sort((a, b) => a.size - b.size)
            const matched = [...smallest!.keys()].filter(entity => rest.every(store => store.has(entity))).sort()

            return matched.map(entity => {
                const meta: Record<string, Meta | undefined> = {}
                const result: Entry = { id: entity, meta: meta }
                every.forEach((member, index) => {
                    // A required member is held by every matched entity; an optional one may not be, and is then undefined.
                    const entry = components.get(member.name)?.get(entity)
                    result[keys[index]!] = entry?.data
                    meta[keys[index]!] = entry && { at: entry.at, rev: entry.rev }
                    if (entry) record(member.name, entity, entry.rev)
                })
                return result
            })
        },
    }
}

/** One entity as a query returns it, before it is typed: its id, and a value per component asked for. */
export type Entry = { id: EntityId; meta: Record<string, Meta | undefined>; [component: string]: unknown }

/**
 * What the store knows about one value besides the value: when it was last
 * written (epoch ms — a reaffirming write counts), and `rev`, which change
 * it is. Two reads with the same `rev` saw the same value.
 */
export type Meta = { at: number; rev: number }

export type StateT = ReturnType<typeof State>

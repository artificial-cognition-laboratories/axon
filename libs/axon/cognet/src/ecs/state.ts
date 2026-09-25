import type {
    ComponentRegistry,
    ComponentStore,
    ComponentType,
    ComponentWatcher,
    EntityId,
    QueryDescriptor,
    Read,
    Stamp,
    WorldQueryResult,
} from "./types"

export type StateOpts = {
    /** The clock's stamp — world mutations are attributed to a tick, phase and system. */
    stamp(): Stamp
    /** Wall clock, for the write time carried with every component. */
    now(): number
}

/**
 * State — the single owner of everything shared inside the world:
 * entity set, component stores, and watchers. Component() and Entity() are
 * views over this; nothing else holds the maps.
 *
 * The world clock does NOT live here. tick/phase belong to Clock(), which
 * every cognet has whether or not it holds a world — see ../clock.ts. State
 * receives a stamp function so world mutations can be attributed to the tick
 * and phase they happened in without owning the counters.
 */
export function State(opts: StateOpts) {
    const entities = new Set<EntityId>()
    const components = new Map<ComponentType, ComponentStore>()
    const watchers = new Map<ComponentType, Set<ComponentWatcher>>()
    let revs = 0
    /** Reads seen during the current observation, keyed so each value is recorded once. Null when nobody is observing. */
    let observed: Map<string, Read> | null = null

    function record(type: ComponentType, entity: EntityId, rev: number): void {
        if (!observed) return
        observed.set(`${entity}\0${type}`, { entity: entity, component: type, rev: rev })
    }

    return {
        entities,
        components,

        /** The next change id. World-monotonic, so a rev names one change uniquely. */
        nextRev(): number {
            revs += 1
            return revs
        },

        /** Note that a value was read, if a run is being observed. */
        record: record,

        /**
         * Runs `fn` and returns every value it read, with the change each one was.
         *
         * Synchronous on purpose: a system run is, and an observation that
         * spanned an await would attribute another caller's reads to this one.
         * Not re-entrant for the same reason — nesting throws rather than
         * silently merging two runs' causes.
         */
        observe<T>(fn: () => T): { result: T; reads: Read[] } {
            if (observed) throw new Error("ecs.observe() is already recording — a nested observation would mix two runs' reads")
            observed = new Map()
            try {
                const result = fn()
                return { result: result, reads: [...observed.values()] }
            } finally {
                observed = null
            }
        },

        /** tick/phase stamp merged into every world event payload. */
        stamp: opts.stamp,

        /** Wall clock at the moment of a write. */
        now: opts.now,

        /**
         * Subscribe to writes on a specific component type.
         * Called synchronously after every write of that component.
         * Returns an unsubscribe function.
         */
        watch(type: ComponentType, handler: ComponentWatcher): () => void {
            let set = watchers.get(type)
            if (!set) {
                set = new Set()
                watchers.set(type, set)
            }
            set.add(handler)
            return () => {
                watchers.get(type)?.delete(handler)
            }
        },

        /** Fire watchers for a component write. A throwing watcher is a bug — it propagates. */
        notify(type: ComponentType, entity: EntityId, data: unknown) {
            const set = watchers.get(type)
            if (!set) return
            for (const watcher of set) watcher(entity, data)
        },

        query<
            const W extends readonly string[] = [],
            const WO extends readonly string[] = [],
            Reg extends Record<string, any> = ComponentRegistry,
        >({
            with: withComponents = [] as unknown as W,
            without: withoutComponents = [] as unknown as WO,
            where,
            filter,
        }: QueryDescriptor<W, WO, Reg>): WorldQueryResult<W, Reg> {
            const stores = components as Map<string, ComponentStore>

            const withStores: Map<EntityId, any>[] = []
            for (const c of withComponents) {
                const store = stores.get(c)
                if (!store) return [] as WorldQueryResult<W, Reg>
                withStores.push(store)
            }

            // Intersect starting from the smallest store
            withStores.sort((a, b) => a.size - b.size)

            let candidates: EntityId[] = []
            const [smallest, ...rest] = withStores
            if (smallest) {
                candidates = [...smallest.keys()].filter(e => rest.every(store => store.has(e)))
            } else {
                const all = new Set<EntityId>()
                for (const store of stores.values()) {
                    for (const e of store.keys()) all.add(e)
                }
                candidates = [...all]
            }

            if (withoutComponents.length > 0) {
                candidates = candidates.filter(e =>
                    withoutComponents.every(c => !stores.get(c)?.has(e))
                )
            }

            if (where) {
                candidates = candidates.filter(e =>
                    Object.entries(where).every(([component, expected]) => {
                        const store = stores.get(component)
                        if (!store?.has(e)) return false
                        return sameValue(store.get(e)!.data, expected)
                    })
                )
            }

            let results: WorldQueryResult<W, Reg> = candidates.map(e => {
                const comps: Record<string, any> = {}
                for (const c of withComponents) {
                    comps[c] = stores.get(c)!.get(e)!.data
                }
                return { entity: e, components: comps as any }
            })

            if (filter) {
                results = results.filter(entry => filter(entry as any))
            }

            // What the caller was handed is what it read — recorded after the
            // filter, because a filtered-out entity influenced nothing.
            for (const entry of results) {
                for (const c of withComponents) record(c as ComponentType, entry.entity, stores.get(c)!.get(entry.entity)!.rev)
            }

            return results
        },
    }
}

export type StateT = ReturnType<typeof State>

/**
 * Structural equality for `where`.
 *
 * Reference equality was the original implementation and silently matched
 * nothing for any component holding an object — which is most of them. A
 * filter that can never match and never complains is worse than one that
 * throws, so it compares by value.
 */
function sameValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false

    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        return a.every((item, index) => sameValue(item, b[index]))
    }

    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

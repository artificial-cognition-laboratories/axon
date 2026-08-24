import type {
    ComponentRegistry,
    ComponentStore,
    ComponentType,
    ComponentWatcher,
    EntityId,
    QueryDescriptor,
    WorldQueryResult,
} from "./types"

export type StateOpts = {
    /** The clock's stamp — world mutations are attributed to a tick and phase. */
    stamp(): { tick: number; phase: string | null }
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

    return {
        entities,
        components,

        /** tick/phase stamp merged into every world event payload. */
        stamp: opts.stamp,

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
            const stores = components as Map<string, Map<EntityId, any>>

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
                        return store.get(e) === expected
                    })
                )
            }

            let results: WorldQueryResult<W, Reg> = candidates.map(e => {
                const comps: Record<string, any> = {}
                for (const c of withComponents) {
                    comps[c] = stores.get(c)!.get(e)
                }
                return { entity: e, components: comps as any }
            })

            if (filter) {
                results = results.filter(entry => filter(entry as any))
            }

            return results
        },
    }
}

export type StateT = ReturnType<typeof State>

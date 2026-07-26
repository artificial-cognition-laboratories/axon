import type {
    ComponentRegistry,
    ComponentStore,
    ComponentType,
    ComponentWatcher,
    EntityId,
    QueryDescriptor,
    WorldQueryResult,
} from "./types"

/**
 * State — the single owner of everything shared inside the world:
 * entity set, component stores, watchers, and the tick/phase counters.
 * Component() and Entity() are views over this; nothing else holds the maps.
 */
export function State() {
    const entities = new Set<EntityId>()
    const components = new Map<ComponentType, ComponentStore>()
    const watchers = new Map<ComponentType, Set<ComponentWatcher>>()

    let tick = 0
    let phase: string | null = null

    return {
        entities,
        components,

        get tick() {
            return tick
        },
        get phase() {
            return phase
        },

        /** Advance to the next tick — called by the loop, nobody else. */
        nextTick(): number {
            tick += 1
            return tick
        },

        setPhase(name: string | null) {
            phase = name
        },

        /** tick/phase stamp merged into every kernel event payload. */
        stamp() {
            return { tick, phase }
        },

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
            if (withStores.length > 0) {
                const [smallest, ...rest] = withStores
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

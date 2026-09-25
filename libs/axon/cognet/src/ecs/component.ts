import type { StateT } from "./state"
import type { ComponentRegistry, ComponentType, EntityId, ComponentData, ComponentEntry } from "./types"
import type { EcsEmit } from "./ecs"

type ComponentOpts = {
    state: StateT
    emit: EcsEmit
}

/**
 * Component — the single write path for component data.
 * Every write emits cognet telemetry and fires watchers; Entity() delegates
 * here so there is exactly one place a component can change.
 *
 * DURABILITY. These events go through abi.emit, which commits to the
 * session log like every other cognet:* event and forwards to the bus after
 * the append lands. They are not bus-only — a brain whose world mutations
 * vanish on restart cannot be debugged after the fact, which is the whole
 * point of the log.
 *
 * The cost is real and known: a continuous-mode cognet ticking fast writes
 * one durable line per component change, which is the highest-volume event
 * source in the system by construction.
 *
 * It is GATED AT THE WRITE, which is the only honest place. A write whose
 * value is structurally identical to the one already stored emits nothing —
 * so a 20Hz loop rewriting an unchanged belief costs nothing, and the log
 * becomes a record of what CHANGED in the mind rather than a stream of
 * identical snapshots. The store is still updated and watchers still fire;
 * only the telemetry is suppressed, because "it is still 0.62" is not news.
 *
 * Do NOT instead route these to the bus alone: events carry `value`, so the
 * log is what makes the world reconstructible after the fact. Trading a
 * measurable cost for an invisible hole is not an optimisation.
 *
 * emit() is fire-and-forget by design (sync, void) so a world write is never
 * an await point.
 */
export function Component(opts: ComponentOpts) {
    const { state, emit } = opts

    return {
        add<K extends ComponentType>({
            entity,
            type,
            data,
        }: {
            entity: EntityId
            type: K
            data: ComponentData<K>
        }) {
            let store = state.components.get(type)
            if (!store) {
                store = new Map<EntityId, ComponentEntry<ComponentData<K>>>()
                state.components.set(type, store)
            }

            const previous = store.get(entity)
            const unchanged = previous !== undefined && same(previous.data, data)

            // The write time advances even when the value did not change: the
            // belief was reaffirmed just now, and something reasoning about
            // staleness needs to know that it is current, not merely unaltered.
            // The rev does not — nothing was emitted to point back to.
            const rev = unchanged ? previous.rev : state.nextRev()
            store.set(entity, { data: data, at: state.now(), rev: rev })

            if (!unchanged) {
                void emit(previous !== undefined ? "cognet:component:update" : "cognet:component:add", {
                    ...state.stamp(),
                    entity,
                    component: type,
                    rev: rev,
                    value: data,
                })
            }

            state.notify(type, entity, data)
        },

        remove<K extends ComponentType>({ entity, type }: { entity: EntityId; type: K }) {
            const store = state.components.get(type)
            if (!store?.has(entity)) return
            store.delete(entity)

            void emit("cognet:component:remove", {
                ...state.stamp(),
                entity,
                component: type,
            })
        },

        get<K extends ComponentType>({
            entity,
            type,
        }: {
            entity: EntityId
            type: K
        }): ComponentData<K> | undefined {
            const entry = state.components.get(type)?.get(entity)
            if (entry) state.record(type, entity, entry.rev)
            return entry?.data
        },

        /**
         * When this belief was last written, in epoch milliseconds.
         *
         * Separate from get() so the ordinary read stays about the value. A
         * caller that cares about age is doing something different — deciding
         * whether to trust it — and should have to say so.
         */
        writtenAt<K extends ComponentType>({ entity, type }: { entity: EntityId; type: K }): number | undefined {
            const entry = state.components.get(type)?.get(entity)
            if (entry) state.record(type, entity, entry.rev)
            return entry?.at
        },

        has<K extends ComponentType>({ entity, type }: { entity: EntityId; type: K }): boolean {
            const entry = state.components.get(type)?.get(entity)
            if (entry) state.record(type, entity, entry.rev)
            return entry !== undefined
        },
    }
}

export type ComponentT = ReturnType<typeof Component>

/**
 * Structural equality, for deciding whether a write is news.
 *
 * Deliberately not JSON.stringify: key order would make two equal objects
 * compare unequal and emit a change that never happened, which is the exact
 * noise this gate exists to remove.
 */
function same(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false

    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        return a.every((item, index) => same(item, b[index]))
    }

    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]))
}

import type { StateT } from "./state"
import type { ComponentRegistry, ComponentType, EntityId } from "./types"
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
 * source in the system by construction. That is acceptable while the ECS is
 * opt-in and unwired (no cognet constructs Ecs() today). Whoever wires the
 * first continuous world should measure it and, if it bites, gate at the
 * write — sample, batch, or make durability a per-component declaration.
 * Do NOT "fix" it by quietly routing these to the bus alone; that trades a
 * measurable cost for an invisible hole.
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
            data: ComponentRegistry[K]
        }) {
            let store = state.components.get(type)
            if (!store) {
                store = new Map<EntityId, ComponentRegistry[K]>()
                state.components.set(type, store)
            }

            const existed = store.has(entity)
            store.set(entity, data)

            void emit(existed ? "cognet:component:update" : "cognet:component:add", {
                ...state.stamp(),
                entity,
                component: type,
            })

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
        }): ComponentRegistry[K] | undefined {
            return state.components.get(type)?.get(entity)
        },

        has<K extends ComponentType>({ entity, type }: { entity: EntityId; type: K }): boolean {
            return state.components.get(type)?.has(entity) ?? false
        },
    }
}

export type ComponentT = ReturnType<typeof Component>

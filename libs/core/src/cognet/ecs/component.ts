import type { AxonHandle } from "@arcforge/types"
import type { StateT } from "./state"
import type { ComponentRegistry, ComponentType, EntityId } from "./types"
import type { EcsEmit } from "./ecs"

type ComponentOpts = {
    state: StateT
    emit: EcsEmit
}

/**
 * Component — the single write path for component data.
 * Every write emits kernel telemetry and fires watchers; Entity() delegates
 * here so there is exactly one place a component can change.
 *
 * Telemetry goes to the runtime bus (→ tracing pipeline), never the session
 * log. Bus emit never rejects (handler errors are re-emitted as
 * axon:bus:error), so firing without await keeps writes synchronous.
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

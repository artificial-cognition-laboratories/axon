import type { ComponentT } from "./component"
import type { StateT } from "./state"
import type { ComponentRegistry, ComponentType, EntityId, ComponentData } from "./types"
import type { EcsEmit } from "./ecs"

type EntityOpts = {
    state: StateT
    component: ComponentT
    emit: EcsEmit
}

/**
 * Entity — membership in the world. Component writes delegate to Component()
 * so telemetry and watchers fire through the single write path.
 */
export function Entity(opts: EntityOpts) {
    const { state, component, emit } = opts

    return {
        add<K extends ComponentType>({
            entity,
            components,
        }: {
            entity: EntityId
            components?:
                | { type: K; data: ComponentData<K> }
                | { type: K; data: ComponentData<K> }[]
        }) {
            state.entities.add(entity)
            void emit("cognet:entity:add", { ...state.stamp(), entity })

            if (!components) return

            const list = Array.isArray(components) ? components : [components]
            for (const { type, data } of list) {
                component.add({ entity, type, data })
            }
        },

        remove({ entity }: { entity: EntityId }) {
            // Remove components through the single write path so removal telemetry fires
            for (const type of [...state.components.keys()]) {
                component.remove({ entity, type })
            }

            state.entities.delete(entity)
            void emit("cognet:entity:remove", { ...state.stamp(), entity })
        },
    }
}

export type EntityT = ReturnType<typeof Entity>

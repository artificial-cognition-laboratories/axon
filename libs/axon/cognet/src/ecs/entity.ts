import type { ComponentT } from "./component"
import type { StateT } from "./state"
import type { EntityId } from "./types"
import type { EcsEmit } from "./ecs"

type EntityOpts = {
    state: StateT
    component: ComponentT
    emit: EcsEmit
}

/**
 * Entity — membership in the world. Removal goes through Component() so
 * removal telemetry and watchers fire through the single write path.
 */
export function Entity(opts: EntityOpts) {
    const { state, emit } = opts

    return {
        add(entity: EntityId): void {
            if (state.entities.has(entity)) return
            state.entities.add(entity)
            void emit("cognet:entity:add", { ...state.stamp(), entity: entity })
        },

        has(entity: EntityId): boolean {
            return state.entities.has(entity)
        },

        all(): EntityId[] {
            return [...state.entities]
        },

        remove(entity: EntityId): void {
            opts.component.purge(entity)

            state.entities.delete(entity)
            void emit("cognet:entity:remove", { ...state.stamp(), entity: entity })
        },
    }
}

export type EntityT = ReturnType<typeof Entity>

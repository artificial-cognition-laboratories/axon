
/**
 * Base ComponentRegistry interface.
 *
 * Kernel systems extend this via module augmentation:
 *
 * declare module "@arcforge/core" {
 *   interface ComponentRegistry {
 *     "my-component": { value: string }
 *   }
 * }
 */
export interface ComponentRegistry {
    // Base components (empty — kernels extend via module augmentation)
}

export type EntityId = string
export type ComponentType = keyof ComponentRegistry
export type ComponentStore<T = any> = Map<EntityId, T>

/** Fired synchronously after every component write of a watched type. */
export type ComponentWatcher = (entity: EntityId, data: unknown) => void

export type WorldQueryResult<
    W extends readonly string[],
    Reg extends Record<string, any> = ComponentRegistry,
> = {
    entity: EntityId
    components: {
        [K in W[number]]: K extends keyof Reg ? Reg[K] : never
    }
}[]

export type QueryDescriptor<
    W extends readonly string[] = [],
    WO extends readonly string[] = [],
    Reg extends Record<string, any> = ComponentRegistry,
> = {
    with?: W
    without?: WO
    where?: Partial<{ [K in keyof Reg]: Reg[K] }>
    filter?: (entry: {
        entity: EntityId
        components: { [K in W[number]]: K extends keyof Reg ? Reg[K] : never }
    }) => boolean
}

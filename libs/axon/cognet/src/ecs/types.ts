
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
/**
 * A component's type name.
 *
 * Falls back to `string` when nothing has augmented the registry, for the same
 * reason `AxonPromptName` does: `keyof` an empty interface is `never`, which
 * makes every parameter typed by it accept NO argument. The whole component
 * API — add, get, has, remove — was uncallable for any consumer that had not
 * augmented `ComponentRegistry` first, including every test in this package.
 *
 * A kernel that DOES augment gets the narrow union and its typo-checking back;
 * one that has not gets a usable API instead of an unusable one.
 */
export type ComponentType = keyof ComponentRegistry extends never ? string : keyof ComponentRegistry

/** The data one component type carries — `unknown` when the registry is unaugmented. */
export type ComponentData<K extends ComponentType> = K extends keyof ComponentRegistry ? ComponentRegistry[K] : unknown
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

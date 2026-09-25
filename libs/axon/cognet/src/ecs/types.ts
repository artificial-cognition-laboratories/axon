
/**
 * Base ComponentRegistry interface.
 *
 * Kernel systems extend this via module augmentation:
 *
 * declare module "@arcforge/cognet" {
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
 * Where in the thought a world mutation happened.
 *
 * `system` is null outside a system bracket — boot-time spawning, or a loop
 * body that writes without going through a schedule. Null is a real answer
 * ("no system did this"), not a missing one.
 */
export type Stamp = { tick: number; phase: string | null; system: string | null }
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
/**
 * What the store holds for one entity's component.
 *
 * The write time travels WITH the data because age is part of a belief's
 * meaning: "position, 50ms old" and "map of the cave, 40 seconds old" are
 * different epistemic objects, and anything choosing between them — an
 * attention system, a reader, a mind — has to be able to tell. Keeping it in a
 * parallel map would let the two drift, which is worse than not having it.
 */
export type ComponentEntry<T = any> = {
    data: T
    /** Wall clock at the write, in epoch milliseconds. */
    at: number
    /**
     * Which recorded change this value is — the `rev` on the event that last
     * CHANGED it. A reaffirming write (same value) advances `at` but keeps
     * `rev`, because it emitted nothing a reader could point back to.
     */
    rev: number
}

/**
 * One value a system read: the entity, the component, and the exact change it
 * saw. The causal parent of whatever that system wrote in the same run.
 */
export type Read = { entity: EntityId; component: ComponentType; rev: number }

export type ComponentStore<T = any> = Map<EntityId, ComponentEntry<T>>

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

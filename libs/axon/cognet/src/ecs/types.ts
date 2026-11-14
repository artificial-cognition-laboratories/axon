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
 * What the store holds for one entity's component.
 *
 * The write time travels WITH the data because age is part of a belief's
 * meaning: "position, 50ms old" and "map of the cave, 40 seconds old" are
 * different epistemic objects, and anything choosing between them has to be
 * able to tell.
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
export type Read = { entity: EntityId; component: string; rev: number }

/** One query call's actual result. Revisions refer to world writes; values are never duplicated in telemetry. */
export type QueryObservation = {
    ordinal: number
    required: string[]
    optional: string[]
    /** Serialisable equality predicate. A function predicate is only marked as present. */
    where?: unknown
    filtered: boolean
    candidates: number
    count: number
    matched: Array<{ entity: EntityId; values: Read[] }>
}

/** One write a system made. */
export type Write = { entity: EntityId; component: string }

export type ComponentStore<T = any> = Map<EntityId, ComponentEntry<T>>

/** Fired synchronously after every write of a watched component. */
export type ComponentWatcher = (entity: EntityId, data: unknown) => void

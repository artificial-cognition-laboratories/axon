import { err } from "@arcforge/err"
import type { Component as Handle } from "./handle"
import type { StateT } from "./state"
import type { ComponentEntry, EntityId } from "./types"
import type { EcsEmit } from "./ecs"

type ComponentOpts = {
    state: StateT
    emit: EcsEmit
}

/**
 * Component — the single write path for component data.
 *
 * Every write emits cognet telemetry and fires watchers; Entity() delegates
 * here so there is exactly one place a component can change.
 *
 * DURABILITY. These events go through abi.emit, which commits them to the
 * session log. A brain whose world mutations vanish on restart cannot be
 * debugged after the fact.
 *
 * HEAVY VALUES ARE DIGESTED. A value whose arrays add up to more than
 * `HEAVY` bytes — a picture, a cloud, a map — is recorded with each array
 * replaced by its kind and length. Held and versioned like any other, it
 * keeps the log small without the author marking anything.
 *
 * GATED AT THE WRITE. A write structurally equal to the stored value emits
 * nothing — the store still updates and watchers still fire — so a 20Hz loop
 * reaffirming an unchanged belief costs nothing in the log, and the log is a
 * record of what CHANGED in the mind.
 */
export function Component(opts: ComponentOpts) {
    const { state, emit } = opts

    function drop(entity: EntityId, name: string): void {
        const store = state.components.get(name)
        if (!store?.has(entity)) return
        store.delete(entity)
        state.wrote(name, entity)
        state.changed(name, state.nextRev())

        void emit("cognet:component:remove", {
            ...state.stamp(),
            entity: entity,
            component: name,
        })
    }

    return {
        /** Write a component's value on an entity. */
        set<T>(entity: EntityId, component: Handle<T>, data: T): void {
            const name = component.name
            let store = state.components.get(name)
            if (!store) {
                store = new Map<EntityId, ComponentEntry<T>>()
                state.components.set(name, store)
            }

            const previous = store.get(entity)
            // Comparing a heavy value element by element on every write would
            // cost more than the write, so every heavy write is a change.
            const heavy = recorded.heavy(data)
            const unchanged = previous !== undefined && !heavy && recorded.same(previous.data, data)

            // The write time advances even when the value did not change: the
            // belief was reaffirmed just now. The rev does not — nothing was
            // emitted to point back to.
            const rev = unchanged ? previous.rev : state.nextRev()
            const at = state.now()
            store.set(entity, { data: data, at: at, rev: rev })
            state.history.record(name, entity, data, at, rev)
            state.wrote(name, entity)
            if (!unchanged) state.changed(name, rev)

            if (!unchanged) {
                void emit(previous !== undefined ? "cognet:component:update" : "cognet:component:add", {
                    ...state.stamp(),
                    entity: entity,
                    component: name,
                    rev: rev,
                    value: heavy ? recorded.digest(data) : data,
                })
            }

            state.notify(name, entity, data)
        },

        remove(entity: EntityId, component: Handle<any>): void {
            drop(entity, component.name)
        },

        /** Remove every component an entity holds — what removing the entity means. */
        purge(entity: EntityId): void {
            for (const name of [...state.components.keys()]) drop(entity, name)
        },

        get<T>(entity: EntityId, component: Handle<T>): T | undefined {
            const name = component.name
            state.look(name)
            const entry = state.components.get(name)?.get(entity)
            if (entry) state.record(name, entity, entry.rev)
            return entry?.data
        },

        /**
         * When this belief was last written, in epoch milliseconds.
         *
         * Separate from get() so the ordinary read stays about the value. A
         * caller that cares about age is deciding whether to trust it, and
         * should have to say so.
         */
        writtenAt(entity: EntityId, component: Handle<any>): number | undefined {
            const name = component.name
            state.look(name)
            const entry = state.components.get(name)?.get(entity)
            if (entry) state.record(name, entity, entry.rev)
            return entry?.at
        },

        has(entity: EntityId, component: Handle<any>): boolean {
            const name = component.name
            state.look(name)
            const entry = state.components.get(name)?.get(entity)
            if (entry) state.record(name, entity, entry.rev)
            return entry !== undefined
        },

        /** Every entity holding this component, with its value. */
        all<T>(component: Handle<T>): Array<{ entity: EntityId; value: T }> {
            const name = component.name
            state.look(name)
            const store = state.components.get(name)
            if (!store) return []
            return [...store.entries()]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([entity, entry]) => {
                    state.record(name, entity, entry.rev)
                    return { entity: entity, value: entry.data as T }
                })
        },
    }
}

export type ComponentT = ReturnType<typeof Component>

/** Above this many bytes of arrays, a value is recorded as a digest. A 6×6 covariance (288) is light; a picture is not. */
const HEAVY = 4_096

/** How a write reaches the log — private to Component. */
const recorded = {
    /** Whether the arrays in `value` add up to more than HEAVY bytes. Measures, never reads, the arrays. */
    heavy(value: unknown): boolean {
        return recorded.bytes(value) > HEAVY
    },

    bytes(value: unknown): number {
        if (typeof value !== "object" || value === null) return 0
        if (ArrayBuffer.isView(value)) return value.byteLength
        let total = 0
        for (const item of Array.isArray(value) ? value : Object.values(value)) total += recorded.bytes(item)
        return total
    },

    /** `value` with every typed array replaced by its kind and length. */
    digest(value: unknown): unknown {
        if (typeof value !== "object" || value === null) return value
        if (ArrayBuffer.isView(value)) {
            const kind = KINDS.get(value.constructor)
            if (!kind) throw err("COGNET_VALUE_INVALID", { detail: `a ${value.constructor.name} cannot be recorded — a component's arrays are Float64Array, Float32Array, Int32Array, Uint32Array or Uint8Array` })
            return { $digest: { kind: kind, length: (value as unknown as ArrayLike<unknown>).length } }
        }
        if (Array.isArray(value)) return value.map(recorded.digest)
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value)) out[key] = recorded.digest(item)
        return out
    },

    /**
     * Structural equality, for deciding whether a write is news.
     *
     * Deliberately not JSON.stringify: key order would make two equal objects
     * compare unequal and emit a change that never happened.
     */
    same(a: unknown, b: unknown): boolean {
        if (Object.is(a, b)) return true
        if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false

        if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
            if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false
            const left = a as unknown as ArrayLike<unknown>
            const right = b as unknown as ArrayLike<unknown>
            if (left.length !== right.length) return false
            for (let index = 0; index < left.length; index++) if (!Object.is(left[index], right[index])) return false
            return true
        }

        if (Array.isArray(a) || Array.isArray(b)) {
            if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
            return a.every((item, index) => recorded.same(item, b[index]))
        }

        const left = a as Record<string, unknown>
        const right = b as Record<string, unknown>
        const keys = Object.keys(left)
        if (keys.length !== Object.keys(right).length) return false
        return keys.every(key => Object.hasOwn(right, key) && recorded.same(left[key], right[key]))
    },
}

/** The name each array kind is recorded as — the same names the run protocol uses. */
const KINDS = new Map<unknown, string>([[Float64Array, "f64"], [Float32Array, "f32"], [Int32Array, "i32"], [Uint32Array, "u32"], [Uint8Array, "u8"]])

import { err } from "@arcforge/err"
import type { SpaceHandle } from "../space"
import type { Coord } from "../coord"
import type { Id } from "../types"
import type { Row } from "./persistence"

/** Quantisation step. 256 levels across [0,1] — one part in 255. */
export const LEVELS = 255

/**
 * Level to value, as a lookup table of exactly the 256 reachable floats.
 *
 * A table rather than a multiply for a correctness reason, not a speed one.
 * `Columns.coord()` writes into a `Float32Array`, so a dequantised value is
 * f32-rounded; computing `level / 255` in f64 anywhere else produces a *different*
 * number, and the ranker then disagreed with the reference metric in the last bit.
 * Indexing a `Float32Array` returns the f32 value both paths must see.
 *
 * It is also faster than the multiply, which is a pleasant accident.
 */
export const DEQUANT = buildDequant()

function buildDequant(): Float32Array {
    const table = new Float32Array(LEVELS + 1)
    for (let level = 0; level <= LEVELS; level++) table[level] = level / LEVELS
    return table
}

/**
 * The columnar index: one dense array per axis, across every row.
 *
 * Columnar rather than row-per-record because the primary query is a per-axis
 * range scan, and a scan of one contiguous array is memory-bandwidth-bound
 * rather than pointer-chasing. At a million rows and a hundred axes that is
 * ~240MB of floats and a three-axis box query is under a millisecond — which is
 * why this needs no approximate index, and why an ANN structure would be
 * actively wrong here: it trades exactness for a speed that is already free.
 *
 * A manager: callers never hold the arrays. `put`, `delete` and `grow` can move
 * every float without anyone downstream knowing.
 */
export function Columns(opts: { space: SpaceHandle; capacity?: number }) {
    const space = opts.space
    const arity = space.axes.length

    let capacity = Math.max(opts.capacity ?? 1024, 1)
    let values = allocate(arity, capacity)
    let conf = allocate(arity, capacity)
    let at = new Float64Array(capacity)
    let live = new Uint8Array(capacity)
    let ids: (Id | undefined)[] = new Array(capacity)

    const slots = new Map<Id, number>()
    let next = 0
    let count = 0

    const handle = {
        get count() {
            return count
        },
        get arity() {
            return arity
        },
        /** Highest slot ever used — the bound every scan runs to. */
        get extent() {
            return next
        },
        get live() {
            return live
        },
        get at() {
            return at
        },

        /**
         * One axis's raw quantised columns.
         *
         * Callers map back to [0,1] through `DEQUANT` — and must use that table
         * rather than a multiply, because the equivalence test between this and the
         * reference metric asserts bit-identical floats.
         */
        column(index: number): { values: Uint8Array; conf: Uint8Array } {
            const column = values[index]
            const confidence = conf[index]
            if (!column || !confidence) throw err("LOCUS_AXIS_UNKNOWN", { detail: `index ${index}`, context: { index: index } })
            return { values: column, conf: confidence }
        },

        slot(id: Id): number | null {
            return slots.get(id) ?? null
        },

        idAt(slot: number): Id | null {
            return ids[slot] ?? null
        },

        put(row: Row): number {
            if (row.values.length !== arity || row.conf.length !== arity) {
                throw err("LOCUS_COORD_ARITY", {
                    detail: `expected ${arity}, got ${row.values.length}`,
                    context: { expected: arity, got: row.values.length },
                })
            }

            const existing = slots.get(row.id)
            const slot = existing ?? next
            if (existing === undefined) {
                if (next === capacity) grow()
                next++
                count++
                slots.set(row.id, slot)
            }

            for (let axis = 0; axis < arity; axis++) {
                values[axis]![slot] = quantise(row.values[axis]!)
                conf[axis]![slot] = quantise(row.conf[axis]!)
            }
            at[slot] = row.at
            live[slot] = 1
            ids[slot] = row.id

            return slot
        },

        delete(id: Id): boolean {
            const slot = slots.get(id)
            if (slot === undefined) return false
            live[slot] = 0
            ids[slot] = undefined
            slots.delete(id)
            count--
            return true
        },

        /**
         * Rebuild a coordinate from its slot.
         *
         * Slices rather than views, so a returned coordinate cannot be
         * invalidated by a later `grow()` reallocating underneath it.
         */
        coord(slot: number): Coord {
            const out = new Float32Array(arity)
            const outConf = new Float32Array(arity)
            for (let axis = 0; axis < arity; axis++) {
                out[axis] = DEQUANT[values[axis]![slot]!]!
                outConf[axis] = DEQUANT[conf[axis]![slot]!]!
            }
            return Object.freeze({ space: space.version, values: out, conf: outConf })
        },

        /** Every live slot, ascending. Insertion order, which is also time order for anything appended. */
        *slotsLive(): Generator<number> {
            for (let slot = 0; slot < next; slot++) {
                if (live[slot] === 1) yield slot
            }
        },
    }

    /** Doubling, so amortised insertion stays constant and a load of N rows reallocates log N times. */
    function grow(): void {
        const nextCapacity = capacity * 2
        const grown = allocate(arity, nextCapacity)
        const grownConf = allocate(arity, nextCapacity)
        for (let axis = 0; axis < arity; axis++) {
            grown[axis]!.set(values[axis]!)
            grownConf[axis]!.set(conf[axis]!)
        }

        const grownAt = new Float64Array(nextCapacity)
        grownAt.set(at)
        const grownLive = new Uint8Array(nextCapacity)
        grownLive.set(live)
        const grownIds: (Id | undefined)[] = new Array(nextCapacity)
        for (let i = 0; i < capacity; i++) grownIds[i] = ids[i]

        values = grown
        conf = grownConf
        at = grownAt
        live = grownLive
        ids = grownIds
        capacity = nextCapacity
    }

    return handle
}

export type ColumnsHandle = ReturnType<typeof Columns>

function allocate(arity: number, capacity: number): Uint8Array[] {
    const out: Uint8Array[] = new Array(arity)
    for (let axis = 0; axis < arity; axis++) out[axis] = new Uint8Array(capacity)
    return out
}

/**
 * [0,1] to a level.
 *
 * Rounds, so a stored value is the NEAREST level rather than the one below — an
 * exact 1 must come back as 1, and an exact 0 as 0, because `conf = 0` is a
 * load-bearing state and truncation would be the one error that cannot be
 * tolerated here.
 */
function quantise(value: number): number {
    return Math.round(value * LEVELS)
}

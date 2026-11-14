import { err } from "@arcforge/err"
import type { Axis } from "./types"

/**
 * The axis table: names, order, and the name→index map every coordinate is
 * read through.
 *
 * Order is identity here. A coordinate is a dense array whose slot `i` holds
 * the reading for `list[i]`, so reordering the table silently reinterprets
 * every stored position — which is why the order is inside the fingerprint and
 * why removal is a tombstone rather than a splice.
 */
export function Axes(opts: { axes: readonly Axis[] }) {
    const list = opts.axes
    const byName = new Map<string, number>()

    for (let i = 0; i < list.length; i++) {
        const axis = list[i]!
        if (byName.has(axis.name)) {
            throw err("LOCUS_AXIS_DUPLICATE", { detail: `two axes are named "${axis.name}"`, context: { axis: axis.name } })
        }
        byName.set(axis.name, i)
    }

    return {
        list: list,
        length: list.length,

        /** The column index for an axis. Throws rather than returning -1: an unknown axis is a typo, and a typo that returns a number writes a belief nothing can read. */
        index(name: string): number {
            const i = byName.get(name)
            if (i === undefined) throw err("LOCUS_AXIS_UNKNOWN", { detail: `this space declares no axis "${name}"`, context: { axis: name } })
            return i
        },

        has(name: string): boolean {
            return byName.has(name)
        },

        at(index: number): Axis {
            const axis = list[index]
            if (!axis) throw err("LOCUS_AXIS_UNKNOWN", { detail: `index ${index}`, context: { index: index } })
            return axis
        },

        names(): string[] {
            return list.map(axis => axis.name)
        },
    }
}

export type AxesHandle = ReturnType<typeof Axes>

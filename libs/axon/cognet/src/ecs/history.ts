import type { EntityId } from "./types"

/** One value written to a streamed component: who it was written on, the value, when, and which change it is. */
export type Written<T = unknown> = {
    entity: EntityId
    value: T
    /** Wall clock at the write, epoch ms — the write's own time, as `writtenAt` gives it. */
    at: number
    /** The change it is (see ComponentEntry.rev): the same as the write before it when the value did not change. */
    rev: number
}

/** A Written as history holds it: numbered, so a reader can say where it got to. */
type Kept = Written & { seq: number }

/**
 * History — every value written to a STREAMED component, in the order it was
 * written, for as long as a reader has not taken it.
 *
 * A component holds its latest value: a system that runs every tick sees each
 * one, and a system that runs less often sees only the last. A stream is the
 * other reading — everything written since the reader last ran — and needs
 * every write kept until each reader has taken it.
 *
 * Every write is numbered, a reaffirming one too: a component's `rev` names
 * CHANGES, and two equal readings of an inner ear are still two readings. A
 * reader's place is a number — `mark()` when it takes what is there — and
 * what every reader has passed is trimmed away. Only components somebody
 * streams are kept at all.
 */
export function History() {
    const kept = new Map<string, Kept[]>()
    let seq = 0

    return {
        /** Keep every write to `component` from now on. */
        keep(component: string): void {
            if (!kept.has(component)) kept.set(component, [])
        },

        /** Whether `component`'s writes are kept. */
        kept(component: string): boolean {
            return kept.has(component)
        },

        /** Record a write, if `component` is kept. */
        record(component: string, entity: EntityId, value: unknown, at: number, rev: number): void {
            const list = kept.get(component)
            if (!list) return
            seq += 1
            list.push({ entity: entity, value: value, at: at, rev: rev, seq: seq })
        },

        /** Where the history stands now: what a reader taking everything has reached. */
        mark(): number {
            return seq
        },

        /** Every write to `component` after `after`, in the order written. */
        since<T>(component: string, after: number): Written<T>[] {
            const list = kept.get(component)
            if (!list) throw new Error(`no history is kept for "${component}" — it is streamed by no system`)
            const from = first(list, after)
            return list.slice(from).map(entry => ({ entity: entry.entity, value: entry.value as T, at: entry.at, rev: entry.rev }))
        },

        /** Whether anything was written to `component` after `after`. */
        waiting(component: string, after: number): boolean {
            const list = kept.get(component)
            return list !== undefined && list.length > 0 && list[list.length - 1]!.seq > after
        },

        /** Let go of every write to `component` at or before `upTo` — what every reader has taken. */
        trim(component: string, upTo: number): void {
            const list = kept.get(component)
            if (!list) return
            const from = first(list, upTo)
            if (from > 0) list.splice(0, from)
        },
    }
}

export type HistoryT = ReturnType<typeof History>

/** The index of the first entry numbered after `after` — the list is in order, so a binary search. */
function first(list: readonly Kept[], after: number): number {
    let low = 0
    let high = list.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (list[middle]!.seq <= after) low = middle + 1
        else high = middle
    }
    return low
}

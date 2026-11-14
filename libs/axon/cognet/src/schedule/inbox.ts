import type { AxonStimulusEntry } from "@arcforge/types"

/**
 * Inbox — stimuli between arrival and each reader's next run.
 *
 * One buffer and a cursor per reading system. Entries are dropped once every
 * reader has taken them, so the buffer holds exactly what the slowest reader
 * has not yet seen.
 */
export function Inbox(opts: { readers: readonly string[] }) {
    let buffer: AxonStimulusEntry[] = []
    /** Arrived, but not yet admitted to a tick. */
    let arriving: AxonStimulusEntry[] = []
    /** Absolute index of buffer[0] — cursors are absolute so trimming never moves them. It is also how many stimuli were admitted before it. */
    let base = 0
    const cursors = new Map<string, number>(opts.readers.map(reader => [reader, 0]))
    /** Each admitted stimulus, and how many readers have yet to finish with it. */
    const unread = new Map<AxonStimulusEntry, number>()

    return {
        /** Take in what arrived. Returns what no system will ever read — done with on arrival. */
        receive(entries: readonly AxonStimulusEntry[]): readonly AxonStimulusEntry[] {
            if (cursors.size === 0) return entries
            arriving.push(...entries)
            return []
        },

        /**
         * A reader is finished with what it took: its run, and anything that
         * run started, has ended. Returns the stimuli every reader is now
         * finished with — SETTLED: whatever the mind was going to do about
         * them, it has done.
         */
        release(entries: readonly AxonStimulusEntry[]): AxonStimulusEntry[] {
            const settled: AxonStimulusEntry[] = []
            for (const entry of entries) {
                const left = unread.get(entry)! - 1
                if (left > 0) unread.set(entry, left)
                else {
                    unread.delete(entry)
                    settled.push(entry)
                }
            }
            return settled
        },

        /**
         * Fix what a tick can see, at the moment it starts. Without this, a
         * stimulus arriving while the tick awaits a trace bracket would reach
         * whichever reader happened to run after it — which tick saw which
         * frame would depend on microtask timing.
         *
         * Says which it admitted by PLACE in the mind's own stream — the
         * `from`th stimulus it ever received, and `count` on — not by seq.
         * A seq is the envelope's, and a confined agent's events are
         * stamped again by the supervisor that records them: the seqs a
         * mind saw named different events in the log (measured 2026-10-09,
         * off by one and drifting), so a replay could not find them.
         */
        admit(): { from: number; count: number } | null {
            const admitted = arriving
            const from = base + buffer.length
            buffer.push(...admitted)
            for (const entry of admitted) unread.set(entry, cursors.size)
            arriving = []
            if (admitted.length === 0) return null
            return { from: from, count: admitted.length }
        },

        /** Whether a reader has stimuli it has not yet taken. */
        waiting(reader: string): boolean {
            const cursor = cursors.get(reader)
            return cursor !== undefined && cursor < base + buffer.length
        },

        take(reader: string): readonly AxonStimulusEntry[] {
            const cursor = cursors.get(reader)
            if (cursor === undefined) throw new Error(`Inbox.take: ${reader} does not read stimuli`)
            const taken = buffer.slice(cursor - base)
            cursors.set(reader, base + buffer.length)
            return taken
        },

        trim(): void {
            if (cursors.size === 0) return
            const slowest = Math.min(...cursors.values())
            buffer = buffer.slice(slowest - base)
            base = slowest
        },
    }
}

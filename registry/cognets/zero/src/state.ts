import type { AxonEntry } from "@arcforge/types"

/**
 * zero's resident mind — module scope IS the RAM. main.ts (the loop) and
 * plugins/ (lifecycle) share this one object by plain import; the compile
 * step bundles them together, so there is exactly one copy per brain.
 *
 * The model is deliberately LOG-SHAPED: `entries` is the session's entry
 * log folded into memory, nothing more. That's not laziness — it's the
 * interop doctrine applied to zero itself: the log is the interchange
 * format, so a model that IS the log is trivially rebuildable (cold boot =
 * sync from seq -1), trivially verifiable (must equal store.session.get()),
 * and needs no schema of its own. Derived structure (summaries, indexes)
 * earns its place here the day zero actually needs it, not before.
 */
export type ZeroState = {
    /** the folded episodic log, in seq order — what render() sees */
    entries: AxonEntry[]
    /** high-water mark: the last seq folded. -1 = nothing yet. */
    seq: number
}

export const state: ZeroState = {
    entries: [],
    seq: -1,
}

/**
 * Fold everything the log has that this mind hasn't — boot hydration and
 * steady-state ticking are the SAME operation with different cursors.
 * Everything zero causes or receives lands in the log (stimuli via ingest,
 * outputs/actions via the kernel's own commits), so syncing at each tick
 * start keeps the model lockstep with the durable record by construction.
 * Idempotent: the seq cursor makes double-folds no-ops.
 */
export function sync(): void {
    for (const entry of kernel.store.session.get({ after: state.seq })) {
        state.entries.push(entry)
        state.seq = entry.time.seq
    }
}

// zero's private store schema — the declaration-merging opt-in (see
// CognetStoreSchema in @arcforge/types). Zero is pure log-derived, so its
// checkpoint is honestly just a cursor: proof the persistence wiring works,
// never load-bearing memory. Deleting it costs a full re-fold and nothing else.
declare global {
    interface CognetStoreSchema {
        checkpoint: { seq: number; savedAt: number }
    }
}

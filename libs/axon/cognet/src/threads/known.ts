import type { StateT } from "../ecs"
import type { Job, WireChange } from "./wire"

/**
 * Known — what one worker holds of the world, as the main thread knows it.
 *
 * A worker keeps every value it has been sent, so a job carries only what
 * changed since: a map recalled every tick crosses once, not every tick.
 * What the worker holds is recorded by VERSION — the entry's rev and write
 * time, which every write replaces — so a value is resent exactly when the
 * world's copy is a different one. Nothing is inferred from a proxy.
 *
 * The worker's own writes are the one subtlety. It keeps them as it makes
 * them, before the world has given them a rev, so from the moment a reply
 * arrives they are FORGOTTEN — main no longer knows what the worker holds
 * there — and PENDING. Once the world commits them they are CONFIRMED:
 * recorded at the world's version, and the worker told that version with its
 * next job. A result that is discarded stays forgotten, and its keys are
 * simply resent.
 *
 * A worker takes its next job as soon as it replies, before its result
 * commits — a lagged result can wait ticks to land. A job sent meanwhile that
 * reads a pending key is sent the world's value, which replaces the worker's
 * own write there; that key is then no longer pending, and its commit
 * confirms nothing — the worker does not hold what the world committed, so
 * it stays forgotten and is resent when next read.
 */
export function Known() {
    /** component → entity → the version the worker holds. */
    const held = new Map<string, Map<string, Version>>()
    /** component → the entities whose value on the worker is its own write, not yet committed. */
    const pending = new Map<string, Set<string>>()

    function store(component: string): Map<string, Version> {
        let found = held.get(component)
        if (!found) {
            found = new Map()
            held.set(component, found)
        }
        return found
    }

    function pendingOf(component: string): Set<string> {
        let found = pending.get(component)
        if (!found) {
            found = new Set()
            pending.set(component, found)
        }
        return found
    }

    return {
        /** What to send so the worker holds exactly the world's values for these components. */
        delta(state: StateT, components: Iterable<string>): Pick<Job, "entries" | "gone"> {
            const entries: Job["entries"] = []
            const gone: Job["gone"] = []
            for (const component of components) {
                const live = state.components.get(component)
                const mine = store(component)
                if (live) {
                    for (const [entity, entry] of live) {
                        const version = mine.get(entity)
                        if (version && version.rev === entry.rev && version.at === entry.at) continue
                        entries.push([component, entity, entry.data, entry.at, entry.rev])
                        mine.set(entity, { rev: entry.rev, at: entry.at })
                        pending.get(component)?.delete(entity)
                    }
                }
                for (const entity of mine.keys()) {
                    if (live?.has(entity)) continue
                    gone.push([component, entity])
                    mine.delete(entity)
                }
                // A pending write the world does not hold: told it is gone, it is no longer the worker's.
                for (const entity of pending.get(component) ?? []) {
                    if (live?.has(entity)) continue
                    gone.push([component, entity])
                    pending.get(component)!.delete(entity)
                }
            }
            return { entries: entries, gone: gone }
        },

        /** The worker changed these itself; until the world confirms them, what it holds there is unknown. */
        forget(changes: readonly WireChange[]): void {
            for (const change of changes) {
                if (change.op === "set" || change.op === "remove") {
                    held.get(change.component)?.delete(change.entity)
                    if (change.op === "set") pendingOf(change.component).add(change.entity)
                } else if (change.op === "drop") {
                    for (const mine of held.values()) mine.delete(change.entity)
                }
            }
        },

        /** The world committed the worker's writes: record the versions it gave them, and return them for the worker. */
        confirm(state: StateT, changes: readonly WireChange[]): Job["confirmed"] {
            const confirmed: Job["confirmed"] = []
            for (const change of changes) {
                if (change.op !== "set") continue
                // Replaced on the worker since by the world's value: it no longer holds this write.
                if (!pending.get(change.component)?.delete(change.entity)) continue
                const entry = state.components.get(change.component)?.get(change.entity)
                if (!entry) continue
                store(change.component).set(change.entity, { rev: entry.rev, at: entry.at })
                confirmed.push([change.component, change.entity, entry.rev, entry.at])
            }
            return confirmed
        },

        /** The worker's writes were discarded: what it holds there stays unknown, and is resent when next read. */
        discard(changes: readonly WireChange[]): void {
            for (const change of changes) if (change.op === "set") pending.get(change.component)?.delete(change.entity)
        },
    }
}

export type KnownT = ReturnType<typeof Known>

type Version = { rev: number; at: number }

import type { Change, StateT } from "../ecs"
import type { Job } from "./wire"

/**
 * The rev of a value the worker wrote itself and the world has not yet
 * confirmed. Never read: a job that reads it carries either its confirmation
 * or the world's own value (see Known).
 */
const PENDING = -1

/**
 * Mirror — a worker's copy of the world, kept in step with the main thread's.
 *
 * The worker side of Known: it holds what it was sent at the version it was
 * sent, plus what its own runs wrote. Writes go straight into the store —
 * this is a copy, so nothing here is a change to narrate, and every entry is
 * replaced rather than mutated, exactly as the live store does.
 */
export function Mirror(opts: { state: StateT }) {
    const { state } = opts

    function store(component: string) {
        let found = state.components.get(component)
        if (!found) {
            found = new Map()
            state.components.set(component, found)
        }
        return found
    }

    return {
        /** Bring the copy up to the world's version for everything a job reads. */
        sync(job: Job): void {
            state.entities.clear()
            for (const entity of job.entities) state.entities.add(entity)
            for (const [component, entity, data, at, rev] of job.entries) store(component).set(entity, { data: data, at: at, rev: rev })
            for (const [component, entity] of job.gone) state.components.get(component)?.delete(entity)
            for (const [component, entity, rev, at] of job.confirmed) {
                const entry = state.components.get(component)?.get(entity)
                if (entry) store(component).set(entity, { data: entry.data, at: at, rev: rev })
            }
        },

        /** Keep what a run wrote, as the world will hold it once it lands. */
        keep(changes: readonly Change[], now: number): void {
            for (const change of changes) {
                if (change.op === "set") store(change.component.name).set(change.entity, { data: change.data, at: now, rev: PENDING })
                else if (change.op === "remove") state.components.get(change.component.name)?.delete(change.entity)
                else if (change.op === "add") state.entities.add(change.entity)
                else {
                    for (const entries of state.components.values()) entries.delete(change.entity)
                    state.entities.delete(change.entity)
                }
            }
        },
    }
}

export type MirrorT = ReturnType<typeof Mirror>

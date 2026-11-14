import { err } from "@arcforge/err"
import { Component, type ComponentT } from "./component"
import { Entity, type EntityT } from "./entity"
import type { Component as Handle } from "./handle"
import { State, type StateT } from "./state"
import type { EntityId } from "./types"

/** What a system touches the world through: the verbs `ecs` exposes. */
export type Surface = {
    component: ComponentT
    entity: EntityT
    rows: StateT["rows"]
    query: StateT["query"]
}

export type IsolationOpts = {
    /** The live world, where the buffer is applied. */
    live: Surface & { state: StateT }
    /** Who is running — named in every refusal. */
    system: string
    /** Component names the run may read: its reads, recalls and writes. */
    reads: ReadonlySet<string>
    /** Component names the run may write. */
    writes: ReadonlySet<string>
}

/**
 * Isolation — the world as an ASYNC system sees it: a snapshot in, a buffer out.
 *
 * An async run outlives its tick, so the live world keeps changing while it
 * awaits. Reading the live world would give it values from several ticks at
 * once; writing it would land results in the middle of some later tick, where
 * half that tick's systems saw the old value and half the new.
 *
 * So the run gets a SNAPSHOT of exactly what it declared, taken when it
 * starts, and its writes go to a BUFFER — applied to the live world in one
 * step, at a tick boundary, by commit(). It reads its own writes, so code in
 * the run behaves exactly as it would synchronously.
 *
 * Declarations are enforced HERE, on every access, rather than after the
 * run: an undeclared component is simply not in the snapshot, and reading it
 * would return `undefined` forever instead of failing.
 *
 * Snapshotting is cheap: stores map entities to entries that every write
 * replaces rather than mutates, so copying a store copies references.
 */
export function Isolation(opts: IsolationOpts) {
    const snapshot = State({ stamp: opts.live.state.stamp, now: opts.live.state.now })
    for (const name of opts.reads) {
        const store = opts.live.state.components.get(name)
        if (store) snapshot.components.set(name, new Map(store))
    }
    for (const entity of opts.live.state.entities) snapshot.entities.add(entity)

    // The snapshot narrates nothing: its writes are provisional until commit,
    // and the live write path emits them then, attributed to the system.
    const quiet = (() => {}) as never
    const local = Component({ state: snapshot, emit: quiet })
    const localEntity = Entity({ state: snapshot, component: local, emit: quiet })

    /** Writes, in order, as they will be applied to the live world. */
    const buffer: Change[] = []

    function readable(name: string): void {
        if (opts.reads.has(name)) return
        throw err("COGNET_UNDECLARED_ACCESS", { detail: `${opts.system} read "${name}" without declaring it in reads or recalls` })
    }

    function writable(name: string): void {
        if (opts.writes.has(name)) return
        throw err("COGNET_UNDECLARED_ACCESS", { detail: `${opts.system} wrote "${name}" without declaring it in writes` })
    }

    const component: ComponentT = {
        set<T>(entity: EntityId, handle: Handle<T>, data: T): void {
            writable(handle.name)
            local.set(entity, handle, data)
            buffer.push({ op: "set", entity: entity, component: handle, data: data })
        },
        remove(entity: EntityId, handle: Handle<any>): void {
            writable(handle.name)
            local.remove(entity, handle)
            buffer.push({ op: "remove", entity: entity, component: handle })
        },
        purge(): void {
            throw err("COGNET_UNDECLARED_ACCESS", { detail: `${opts.system} cannot purge an entity — use ecs.entity.remove` })
        },
        get<T>(entity: EntityId, handle: Handle<T>): T | undefined {
            readable(handle.name)
            return local.get(entity, handle)
        },
        writtenAt(entity: EntityId, handle: Handle<any>): number | undefined {
            readable(handle.name)
            return local.writtenAt(entity, handle)
        },
        has(entity: EntityId, handle: Handle<any>): boolean {
            readable(handle.name)
            return local.has(entity, handle)
        },
        all<T>(handle: Handle<T>): Array<{ entity: EntityId; value: T }> {
            readable(handle.name)
            return local.all(handle)
        },
    }

    const entity: EntityT = {
        add(id: EntityId): void {
            localEntity.add(id)
            buffer.push({ op: "add", entity: id })
        },
        has(id: EntityId): boolean {
            return localEntity.has(id)
        },
        all(): EntityId[] {
            return localEntity.all()
        },
        remove(id: EntityId): void {
            // Removing an entity removes every component it holds — so every
            // one of them must be the run's to write.
            for (const [name, store] of snapshot.components) if (store.has(id)) writable(name)
            localEntity.remove(id)
            buffer.push({ op: "drop", entity: id })
        },
    }

    const surface: Surface = {
        component: component,
        entity: entity,
        query: snapshot.query,
        rows(members: readonly Handle<any>[], optional: readonly Handle<any>[] = []) {
            for (const member of [...members, ...optional]) readable(member.name)
            return snapshot.rows(members, optional)
        },
    }

    return {
        surface: surface,

        /** The snapshot, as a world: what a run started elsewhere — on a worker — is sent, taken now. */
        world: snapshot,

        /**
         * Runs `fn` against the snapshot, returning what it read. Synchronous
         * only — what a worker thread wraps a run in. An async run's reads
         * span awaits and cannot be attributed this way.
         */
        observe: snapshot.observe,
        observeAsync: snapshot.observeAsync,

        /** The buffered writes, in order — what a worker thread sends back. */
        changes(): readonly Change[] {
            return buffer
        },

        /** Apply every buffered write to the live world, in the order it was made. */
        commit(): void {
            changes.apply(opts.live, buffer, writable)
            buffer.length = 0
        },
    }
}

/** One buffered write. Data rather than a closure, so it can cross to another thread. */
export type Change =
    | { op: "set"; entity: EntityId; component: Handle<any>; data: unknown }
    | { op: "remove"; entity: EntityId; component: Handle<any> }
    | { op: "add"; entity: EntityId }
    | { op: "drop"; entity: EntityId }

export const changes = {
    /**
     * Apply writes to the live world, in order, each checked by `writable` —
     * again, because a list may have crossed from another thread. An
     * entity's removal is checked against the LIVE world: it may hold
     * components a snapshot never copied, and removal would take those too.
     */
    apply(live: Surface & { state: StateT }, list: readonly Change[], writable: (name: string) => void): void {
        for (const change of list) {
            if (change.op === "set") {
                writable(change.component.name)
                live.component.set(change.entity, change.component, change.data)
            } else if (change.op === "remove") {
                writable(change.component.name)
                live.component.remove(change.entity, change.component)
            } else if (change.op === "add") live.entity.add(change.entity)
            else {
                for (const [name, store] of live.state.components) if (store.has(change.entity)) writable(name)
                live.entity.remove(change.entity)
            }
        }
    },
}

export type IsolationT = ReturnType<typeof Isolation>

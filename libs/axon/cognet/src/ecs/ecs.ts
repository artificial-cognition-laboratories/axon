import { AsyncLocalStorage } from "node:async_hooks"
import type { KernelAbi } from "@arcforge/types"
import { err } from "@arcforge/err"
import { changes, Isolation, type Change, type Surface } from "./isolation"
import { Component } from "./component"
import { Entity } from "./entity"
import { Named } from "./named"
import { Schema } from "./schema"
import { State } from "./state"
import type { Stamp } from "./types"

/** Telemetry sink — cognets pass abi.emit; fire-and-forget, never awaited. Typed against cognet:*. */
export type EcsEmit = KernelAbi["emit"]

export type EcsOpts = {
    emit: EcsEmit
    /**
     * Wall clock for write times. Injected rather than calling Date.now()
     * inside the store so a test can make staleness deterministic.
     *
     * Deliberately NOT part of stamp(): stamp is spread into event payloads,
     * and the envelope already carries one authoritative time. Two times on one
     * event is a contradiction waiting to be believed.
     */
    now?: () => number
    /**
     * The clock's stamp. Every world mutation is attributed to the tick,
     * phase and system it happened in, so the mutation history replays against
     * the clock — and says who wrote each belief — rather than being a flat
     * list of writes.
     */
    stamp(): Stamp
}

/**
 * Ecs — the cognet's world: entities, components, and queries over both.
 *
 * LIFETIME IS THE COGNET'S, not the wake's. This was wake-scoped, on the
 * reasoning that anything outliving a wake could be re-derived from the log.
 * That holds for an invocation cognet, where a wake is a whole conversation
 * turn. It is wrong for a continuous one: every tick is a wake, so the world
 * would be rebuilt twenty times a second, and beliefs that exist precisely
 * BECAUSE they persist — a decaying drive, a remembered place, how long a
 * fall has lasted — could not be represented at all.
 *
 * So the world is the cognet's short-term memory, and the session log is what
 * makes it reconstructible afterwards rather than what reconstitutes it every
 * tick. Durable long-term state still belongs in kernel.store.
 *
 * Deliberately opt-in: the host constructs this lazily, on first touch of the
 * `ecs` global, so a control loop that never queries an entity carries none
 * of it.
 *
 * State() owns the store; Component() and Entity() are the write paths, and
 * Entity delegates to Component so there is exactly one place a component can
 * change — which is what makes telemetry and watchers reliable rather than
 * best-effort. Schema() owns how each component is rendered, told once.
 *
 * A SYSTEM reads and writes by name — `ecs.query({ components: ["velocity"] })`,
 * `ecs.set({ id, components: { velocity: value } })` — typed by `C`, the map of
 * every component's name to its type that the compile step generates. The
 * handle verbs under `component` are what those resolve to.
 */
export function Ecs<C extends object = Record<string, unknown>>(opts: EcsOpts) {
    const state = State({ stamp: opts.stamp, now: opts.now ?? (() => Date.now()) })

    const schema = Schema({ emit: opts.emit })
    const component = Component({ state: state, emit: opts.emit })
    const entity = Entity({ state: state, component: component, emit: opts.emit })
    const live: Surface = { component: component, entity: entity, rows: state.rows, query: state.query }

    /**
     * The isolation an async system's run is executing in, per async
     * context. Every verb below resolves through it, so code inside an async
     * system writes `ecs.component.set(...)` exactly as a sync one does and
     * reaches its own snapshot and buffer.
     */
    const isolated = new AsyncLocalStorage<Surface>()
    const surface = () => isolated.getStore() ?? live
    const named = Named<C>({ surface: surface })

    return {
        state: state,
        schema: schema,
        get entity(): Surface["entity"] { return surface().entity },
        get component(): Surface["component"] { return surface().component },

        /** Every entity holding the named components, one object each, in entity order. */
        query: named.query,
        /** Write one entity's components: a value sets, null removes, undefined leaves alone. */
        set: named.set,
        watch: state.watch,
        /** Runs `fn`, returning what it read and wrote. What the scheduler wraps each system in. */
        observe: state.observe,

        /**
         * Give an async run its own view: a snapshot of what it may read, a
         * buffer for what it writes. `run(fn)` executes `fn` inside it;
         * `commit()` applies the buffer to the live world.
         */
        isolate(isolation: { system: string; reads: ReadonlySet<string>; writes: ReadonlySet<string> }) {
            const view = Isolation({ ...isolation, live: { ...live, state: state } })
            return {
                run<T>(fn: () => T): T {
                    return isolated.run(view.surface, fn)
                },
                /** Run a SYNC `fn` inside the view, returning what it read. */
                observe<T>(fn: () => T) {
                    return view.observe(() => isolated.run(view.surface, fn))
                },
                observeAsync<T>(fn: () => Promise<T>) {
                    return view.observeAsync(() => isolated.run(view.surface, fn))
                },
                changes: view.changes,
                commit: view.commit,
                /** The snapshot as a world — taken when the view was made. */
                world: view.world,
            }
        },

        /**
         * Apply writes made elsewhere — a worker thread's run — to the live
         * world, refusing any the system did not declare.
         */
        apply(from: { system: string; writes: ReadonlySet<string> }, list: readonly Change[]): void {
            changes.apply({ ...live, state: state }, list, name => {
                if (from.writes.has(name)) return
                throw err("COGNET_UNDECLARED_ACCESS", { detail: `${from.system} wrote "${name}" without declaring it in writes` })
            })
        },
    }
}

export type EcsT<C extends object = Record<string, unknown>> = ReturnType<typeof Ecs<C>>

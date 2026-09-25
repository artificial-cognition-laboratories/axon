import type { KernelAbi } from "@arcforge/types"
import { Component } from "./component"
import { Entity } from "./entity"
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
 * best-effort. Schema() owns what each component type IS, told once.
 */
export function Ecs(opts: EcsOpts) {
    const state = State({ stamp: opts.stamp, now: opts.now ?? (() => Date.now()) })

    const schema = Schema({ emit: opts.emit })
    const component = Component({ state: state, emit: opts.emit })
    const entity = Entity({ state: state, component: component, emit: opts.emit })

    return {
        state: state,
        schema: schema,
        entity: entity,
        component: component,

        declare: schema.declare,
        frame: schema.frame,
        query: state.query,
        watch: state.watch,
        /** Runs `fn`, returning the exact values it read. What a scheduler wraps each system in. */
        observe: state.observe,
    }
}

export type EcsT = ReturnType<typeof Ecs>

import type { KernelAbi } from "@arcforge/types"
import { Component } from "./component"
import { Entity } from "./entity"
import { State } from "./state"

/** Telemetry sink — cognets pass abi.emit; fire-and-forget, never awaited. Typed against cognet:*. */
export type EcsEmit = KernelAbi["emit"]

export type EcsOpts = {
    emit: EcsEmit
    /**
     * The clock's stamp. Every world mutation is attributed to the tick and
     * phase it happened in, so the mutation history replays against the clock
     * rather than being a flat list of writes.
     */
    stamp(): { tick: number; phase: string | null }
}

/**
 * Ecs — the wake-scoped world: entities, components, and queries over both.
 *
 * A WORKING SET, not memory. Persistence lives in the session log and durable
 * cognitive state in kernel.store; if an entity matters beyond this wake, it
 * was derived from the log and the next wake derives it again.
 *
 * Deliberately opt-in. The world clock (tick/phase/system) is separate and
 * always present — see ../clock.ts — so a control loop or perception stack
 * that never queries an entity carries none of this.
 *
 * State() owns the store; Component() and Entity() are the write paths, and
 * Entity delegates to Component so there is exactly one place a component can
 * change — which is what makes telemetry and watchers reliable rather than
 * best-effort.
 */
export function Ecs(opts: EcsOpts) {
    const state = State({ stamp: opts.stamp })

    const component = Component({ state, emit: opts.emit })
    const entity = Entity({ state, component, emit: opts.emit })

    return {
        state: state,
        entity: entity,
        component: component,

        query: state.query,
        watch: state.watch,
    }
}

export type EcsT = ReturnType<typeof Ecs>

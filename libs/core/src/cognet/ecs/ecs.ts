import type { AxonHandle } from "@arcforge/types"
import { Component } from "./component"
import { Entity } from "./entity"
import { Loop } from "./loop"
import { State } from "./state"

import type { KernelAbi } from "@arcforge/types"

/** Telemetry sink — cognets pass abi.emit; fire-and-forget, never awaited. Typed against cognet:*. */
export type EcsEmit = KernelAbi["emit"]

export type EcsOpts = {
    emit: EcsEmit
    /** The wake's own abort signal — forwarded to Loop() so tick/phase/system can tell an interrupt apart from a real failure. */
    signal?: AbortSignal
}

/**
 * Ecs — the request-scoped world. Constructed fresh per kernel request,
 * dies when the loop stops. Persistence lives in the session log,
 * not here.
 *
 * State() owns the store; Component() and Entity() are the write paths;
 * the loop drives tick/phase via state.nextTick()/setPhase().
 */
export function Ecs(opts: EcsOpts) {
    const state = State()

    const component = Component({ state, emit: opts.emit })
    const entity = Entity({ state, component, emit: opts.emit })
    const loop = Loop({ state, emit: opts.emit, signal: opts.signal })

    return {
        state: state,
        entity: entity,
        component: component,

        query: state.query,
        watch: state.watch,

        // execution wrappers — the only writers of the world clock
        tick: loop.tick,
        phase: loop.phase,
        system: loop.system,
    }
}

export type EcsT = ReturnType<typeof Ecs>

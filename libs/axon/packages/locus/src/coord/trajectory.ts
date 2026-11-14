import type { SpaceHandle } from "../space"
import { distance } from "./distance"
import { centroid } from "./shape"
import type { Coord } from "./types"

export type TrajectoryOpts = {
    /** Judge motion within one domain only. */
    domain?: string
}

/**
 * An ordered walk through the space — earliest first.
 *
 * Temporal structure computed with no model and no latency, which is what makes
 * it worth having: "am I stuck", "is this settling", "did I get anywhere" are
 * questions a deliberating layer would otherwise burn seconds on, and answering
 * them cheaply is how that layer earns the right to be slow.
 *
 * A trajectory is also the raw form of a BEHAVIOUR. Consolidating many aligned
 * trajectories into a prototype is the same operation as consolidating many
 * positions into a region — one mechanism, applied to sequences instead of
 * points.
 */
export function trajectory(space: SpaceHandle, positions: readonly Coord[], opts: TrajectoryOpts = {}) {
    const scoped: { domain?: string } = opts.domain === undefined ? {} : { domain: opts.domain }

    const handle = {
        positions: positions,

        /** Per-step change. `[0.05, 0.81, 0.04]` is a spike at step two — something shifted sharply and then held. */
        velocity(): number[] {
            const out: number[] = []
            for (let i = 1; i < positions.length; i++) {
                out.push(distance(space, positions[i - 1]!, positions[i]!, scoped))
            }
            return out
        },

        /** Change in velocity. Positive is destabilising, negative is settling. */
        acceleration(): number[] {
            const v = handle.velocity()
            const out: number[] = []
            for (let i = 1; i < v.length; i++) out.push(v[i]! - v[i - 1]!)
            return out
        },

        /** How far the end is from the start. Low after a turbulent middle means it came back. */
        drift(): number {
            if (positions.length < 2) return 0
            return distance(space, positions[0]!, positions[positions.length - 1]!, scoped)
        },

        /** The centre of mass — a baseline any single step can be measured against. */
        centroid(): Coord {
            return centroid(space, positions)
        },

        /**
         * Is it revisiting ground it has already covered?
         *
         * Non-adjacent steps only: consecutive positions are supposed to be
         * similar, so counting them would report every smooth walk as a loop.
         */
        isLooping(threshold = 0.15): boolean {
            for (let i = 0; i < positions.length - 2; i++) {
                for (let j = i + 2; j < positions.length; j++) {
                    if (distance(space, positions[i]!, positions[j]!, scoped) <= threshold) return true
                }
            }
            return false
        },

        /** Is it approaching equilibrium — second half slower than the first? */
        isSettling(): boolean {
            const v = handle.velocity()
            if (v.length < 2) return false
            const mid = Math.floor(v.length / 2)
            const first = v.slice(0, mid).reduce((sum, x) => sum + x, 0) / mid
            const second = v.slice(mid).reduce((sum, x) => sum + x, 0) / (v.length - mid)
            return second < first
        },

        /** A window, composable — every method works on the result. */
        slice(from: number, to?: number) {
            return trajectory(space, positions.slice(from, to), opts)
        },
    }

    return handle
}

export type TrajectoryHandle = ReturnType<typeof trajectory>

import type { BodyInfo, BodyState, RunningWorld } from "../types"

/**
 * What a body is, to the pool that keeps it warm.
 *
 * Hand-written because it is the seam between `Pool` and the engines: the pool
 * owns the whole warm-body lifecycle — booting spares, leasing, sweeping dead
 * agents, replacing failures — and none of that is Terraria's or Minecraft's.
 * What IS per-engine is everything behind these verbs: how a client is
 * launched, what a save looks like, and what joining a world means.
 *
 * `join` takes the world rather than a host and port so an engine can use
 * whatever it needs of it — Terraria wants the password, Minecraft has none —
 * without the pool knowing which fields matter to whom.
 */
export type BodyHandle = {
    readonly id: string
    readonly state: BodyState
    /** The body's engine bridge an agent connects to. */
    readonly bridge: string
    /** The screen's pixels in shared memory — see Display. */
    readonly screen: string
    /** Where captured audio lands, newest last. */
    readonly audio: string
    /** What that audio is: samples a second, and how many channels. */
    readonly hearing: { sampleRate: number; channels: number }

    /** What this body is, to a surface. `world` is where the pool has it — null while it is warm and in none. */
    info(lease: { id: string; agent: string } | null, world: string | null): BodyInfo

    /** Boot to the menu. Resolves `ready`; on any failure the body is `failed` and this throws. */
    boot(): Promise<void>

    /** Enter the world under this identity, with its durable state copied in from `stateDir`. */
    join(input: { identity: string; stateDir: string; world: RunningWorld }): Promise<void>

    /** Leave the world, handing any durable state back to `stateDir`. */
    leave(input: { stateDir: string }): Promise<void>

    /** Drop all but the newest captured audio. The pool calls this on every sweep. */
    prune(): Promise<void>


    /** Frozen while nobody is in it — see `Rest`. */
    readonly resting: boolean

    /** Freeze an idle body's working processes. Only a `ready`, unleased body rests. */
    rest(): void

    /** Unfreeze it. Instant; the pool wakes a body before putting anyone in it. */
    wake(): void

    /** Stop every process. Final: a stopped body is never started again. */
    stop(): Promise<void>
}

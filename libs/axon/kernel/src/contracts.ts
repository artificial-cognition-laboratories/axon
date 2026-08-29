import type { EngineRequirements, AxonBlueprint, CognetSchedule, CognetWake, KernelAbi } from "@arcforge/types"

/**
 * What ring 0 requires of its injected collaborators — declared structurally,
 * not imported.
 *
 * The kernel is constructed by a composition root it must never depend on:
 * @arcforge/core builds the bus and loads the cognet artifact, then hands both in.
 * Importing their implementation types would invert the rings and make a
 * published kernel depend on a private package.
 *
 * These are narrow on purpose. Each lists only what the kernel actually
 * touches, so the surface a future host has to satisfy is small and honest.
 */

/** Announce a committed event. The kernel forwards capsule and wake activity through this. */
export type KernelBus = {
    forward(event: { type: string }): Promise<void>
    onAny(handler: (event: string, payload: unknown) => void): () => void
}

/**
 * The loaded brain. The kernel exec's it once, wakes it, and unloads it — it
 * never learns how the artifact was resolved or what the cognition does.
 */
export type KernelCognet = {
    readonly name: string
    readonly mode: CognetSchedule
    /**
     * Which entry types wake this brain. Absent = everything.
     *
     * Read by the scheduler's stimulus trigger. A conversational cognet
     * declares nothing and hears all of it; one attached to a firehose
     * sensor names the few kinds worth a thought.
     */
    readonly wakeOn?: readonly string[]
    /**
     * The inference roles this brain declared.
     *
     * Read only when inference is REMOTE: role resolution then happened in the
     * supervisor, so this process has no binding to read capability facts
     * from, and the declaration is the honest answer to "what did this role
     * ask for". It is also all a confined agent may know — the resolved
     * capability names a provider and a model the boundary exists to hide.
     */
    readonly engines?: EngineRequirements
    load(abi: KernelAbi): Promise<void>
    wake(wake: CognetWake): Promise<void>
    update(blueprint: AxonBlueprint): Promise<void> | void
    unload(): Promise<void> | void
}

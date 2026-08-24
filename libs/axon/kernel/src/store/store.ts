import type { KernelStore } from "@arcforge/types"
import type { AxonBlueprint } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"
import { home } from "@arcforge/session"
import path from "node:path"

type StoreOpts = {
    blueprint: AxonBlueprint
    /** The cognet this store belongs to — its private namespace on disk. */
    cognet: { readonly name: string }
    /** Environmental, same handle the kernel mediates output()/run() through. */
    session: AxonSessionT
}

/**
 * Store — the cognet's persistence resource, one door with two rooms and
 * two ownership regimes (see KernelStore in @arcforge/types for the doctrine):
 *
 * - `session` — READ-ONLY view of the session's entry log, the kernel's
 *   live in-memory projection. Entries only, by construction: it reads
 *   session.entries (already classified by type namespace), so kernel
 *   telemetry and error machinery are unreachable from ring 3. This is
 *   how a cognet rehydrates at boot without anything being passed in.
 * - the kv — the cognet's private consolidated state, whole-value JSON
 *   under data/state/<cognet-name>/, path authority in home.ts. Engine
 *   invisible on purpose: the contract is get/set, not files — a db can
 *   move in behind this door without any cognet noticing.
 *
 * Typed against CognetStoreSchema (declaration merging) at the ABI seam;
 * this implementation is honest about what it really moves: unknown JSON.
 */
export function Store(opts: StoreOpts): KernelStore {
    const root = path.resolve(opts.blueprint.paths.root, opts.blueprint.paths.data)

    return {
        session: {
            get(getOpts?: { after?: number }) {
                const entries = opts.session.entries
                if (getOpts?.after === undefined) return entries
                return entries.filter(entry => entry.time.seq > getOpts.after!)
            },
        },

        async get(key) {
            return (await home.data.state.read(root, opts.cognet.name, key as string)) as CognetStoreSchema[typeof key] | null
        },

        async set(key, value) {
            await home.data.state.write(root, opts.cognet.name, key as string, value)
        },
    }
}

export type StoreT = ReturnType<typeof Store>

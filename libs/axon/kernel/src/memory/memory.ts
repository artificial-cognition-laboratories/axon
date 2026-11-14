import type { AxonBlueprint, KernelMemory, MemoryConnection } from "@arcforge/types"
import { home } from "@arcforge/session"
import { err } from "@arcforge/err"
import path from "node:path"

type MemoryOpts = {
    blueprint: AxonBlueprint
    /** The cognet whose memory this is — its own namespace on disk. */
    cognet: { readonly name: string }
}

/** A database name: one lowercase identifier. Nothing in it can be read as a path. */
const NAME = /^[a-z][a-z0-9-]*$/

/**
 * Memory — where a cognet's long-term databases live (see KernelMemory in
 * @arcforge/types for the doctrine).
 *
 * The kernel says where; the cognet's own engine opens it. Today every
 * database is a sqlite file in the agent's data. A hosted agent would
 * answer `remote`, and no cognet would notice.
 */
export function Memory(opts: MemoryOpts): KernelMemory {
    const root = path.resolve(opts.blueprint.paths.root, opts.blueprint.paths.data)

    return {
        connect(name: string): MemoryConnection {
            if (!NAME.test(name)) {
                throw err("MEMORY_NAME_INVALID", { detail: `"${name}" is not a database name — one lowercase identifier: a letter, then letters, digits or dashes`, context: { name: name } })
            }
            return { type: "sqlite", path: home.data.memory.path(root, opts.cognet.name, name) }
        },
    }
}

export type MemoryT = ReturnType<typeof Memory>

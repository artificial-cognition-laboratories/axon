import { err } from "@arcforge/err"
import type { SpaceHandle } from "../space"
import type { Persistence, StoredBasis } from "./persistence"

/**
 * The stored basis, checked against the basis this code declares.
 *
 * This runs before a single float is interpreted, and it is the most important
 * guard in the package. Every stored coordinate is expressed IN a basis — so a
 * build whose axis table has drifted would not fail, it would silently
 * reinterpret every position in the memory and answer plausibly forever. That
 * is the one failure mode a memory system cannot recover from, because nothing
 * downstream can tell a wrong answer from a right one.
 *
 * A fresh store adopts the code's space. An existing one must match it exactly,
 * or the caller migrates.
 */
export async function Basis(opts: { space: SpaceHandle; persistence: Persistence }) {
    const space = opts.space
    const persistence = opts.persistence

    const stored = await persistence.basis.read()
    const current = stored ?? (await adopt())

    if (current.version !== space.version) {
        throw err("LOCUS_BASIS_MISMATCH", {
            detail: `stored basis ${current.version} (${current.axes.length} axes), this build declares ${space.version} (${space.axes.length} axes)`,
            context: {
                stored: current.version,
                declared: space.version,
                added: space.axes.names().filter(name => !current.axes.includes(name)),
                removed: current.axes.filter(name => !space.axes.has(name)),
            },
        })
    }

    return {
        version: current.version,
        ordinal: current.ordinal,
        axes: current.axes,
        writtenAt: current.writtenAt,
    }

    /** First open against an empty store — the declared space becomes the stored one. */
    async function adopt(): Promise<StoredBasis> {
        const basis: StoredBasis = {
            version: space.version,
            ordinal: 1,
            axes: space.axes.names(),
            writtenAt: Date.now(),
        }
        await persistence.basis.write(basis)
        return basis
    }
}

export type BasisHandle = Awaited<ReturnType<typeof Basis>>

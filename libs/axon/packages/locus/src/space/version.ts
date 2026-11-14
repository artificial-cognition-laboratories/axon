import type { Axis } from "./types"

/**
 * The basis fingerprint — derived from the axes themselves so it cannot drift.
 *
 * An integer someone remembers to bump is a version that is wrong exactly when
 * it matters. This is a content hash, so two builds agree if and only if they
 * genuinely declare the same space.
 *
 * What is INSIDE the hash is the whole of the compatibility rule:
 *   - name, domain, kind, levels, question  → change one and stored
 *     coordinates change meaning. Breaking.
 *   - order                                 → the index a value is stored at.
 *     Breaking.
 *   - weight, metric                        → query-time only. NOT hashed.
 *
 * FNV-1a rather than sha256 so `space/` stays dependency-free and importable
 * anywhere: this is a fingerprint, never a security boundary.
 */
export function fingerprint(axes: readonly Axis[]): string {
    let hash = 0xcbf29ce484222325n
    const prime = 0x100000001b3n
    const mask = 0xffffffffffffffffn

    for (const axis of axes) {
        const levels = axis.levels ? axis.levels.join("\u001f") : ""
        const line = `${axis.name}\u001e${axis.domain}\u001e${axis.kind}\u001e${levels}\u001e${axis.question}\u001d`
        for (let i = 0; i < line.length; i++) {
            hash = ((hash ^ BigInt(line.charCodeAt(i))) * prime) & mask
        }
    }

    return hash.toString(16).padStart(16, "0")
}

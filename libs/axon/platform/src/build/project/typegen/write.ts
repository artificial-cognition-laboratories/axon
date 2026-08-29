import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Frame, type ProjectKind } from "../../frame"

/**
 * Declaration output for one project. Each kind writes into the `types/` area
 * of its own dotted frame directory — .agent/types/, .module/types/, … —
 * whose location comes from Frame() rather than being spelled here, so a new
 * kind cannot silently land in another's frame and the interior layout is
 * decided in exactly one place.
 */

/**
 * Every kind typegen can write for — which is every kind.
 *
 * An alias, not a second union. This was spelled out as its own five-member
 * list and had already drifted: adding a kind to the table left typegen
 * rejecting it, with the error surfacing here rather than where the kind was
 * declared. Whether a kind gets declarations is `KINDS[kind].frame`'s job to
 * say, not this type's.
 */
export type TypegenKind = ProjectKind

/** Ensure the project's generated-types dir exists and return it. */
export function ensureOutDir(root: string, kind: TypegenKind = "agent"): string {
    return Frame({ root: root, kind: kind }).ensure("types")
}

/** Write one declaration file into the project's generated-types dir. */
export function writeDts(root: string, filename: string, content: string, kind: TypegenKind = "agent"): void {
    writeFileSync(join(ensureOutDir(root, kind), filename), content, "utf-8")
}

/** kebab-case → PascalCase. */
export function toPascalCase(name: string): string {
    return name
        .split("-")
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join("")
}

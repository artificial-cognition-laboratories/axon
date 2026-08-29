import { join } from "node:path"
import { cp, readdir, readlink, rm } from "node:fs/promises"
import { isAbsolute } from "node:path"

/**
 * Replace every absolute symlink under a tree with a real copy of its target.
 *
 * Relative links are left alone — they resolve within the tree and survive it
 * moving. An absolute one points at wherever the install happened to run, so
 * it dangles the moment that directory is deleted; resolving it here, while
 * the target still exists, is what makes the tree self-contained.
 *
 * Does NOT descend through links: a symlinked package directory is another
 * entry's content, so following it would revisit the same files repeatedly and,
 * for a link out of the tree, walk off into the source install.
 */
export async function resolveAbsoluteLinks(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
        const path = join(dir, entry.name)

        if (entry.isSymbolicLink()) {
            const to = await readlink(path).catch(() => null)
            if (to === null || !isAbsolute(to)) continue
            await rm(path, { force: true })
            await cp(to, path, { recursive: true, dereference: true })
        } else if (entry.isDirectory()) {
            await resolveAbsoluteLinks(path)
        }
    }
}


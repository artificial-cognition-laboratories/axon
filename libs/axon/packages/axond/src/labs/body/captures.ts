import { readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Keep the newest `kept` files with this extension; delete the rest.
 *
 * Shared by sight and hearing because both capture into a folder a reader
 * drains, and both would otherwise fill a disk over a long embodiment. A pure
 * value-and-filesystem helper with no state, which is why it is a function
 * rather than a handle.
 */
export async function trim(dir: string, extension: string, kept: number): Promise<void> {
    if (!existsSync(dir)) return
    const names = (await readdir(dir)).filter(name => name.endsWith(extension)).sort()
    for (const name of names.slice(0, Math.max(0, names.length - kept))) {
        await rm(join(dir, name), { force: true })
    }
}

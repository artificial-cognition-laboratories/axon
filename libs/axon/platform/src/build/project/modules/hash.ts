import { createHash } from "node:crypto"
import { join } from "node:path"
import { fsx } from "../../../utils/fs"

/**
 * A source module's content hash — its version identity.
 *
 * Covers exactly what a consumer of the module would see: its declaration
 * (module.config.ts), its manifest (package.json), and its source tree. Build
 * output and node_modules are deliberately excluded — they are derived, and
 * hashing them would make the identity change without the module changing.
 *
 * Files are folded in sorted order (fsx.walk sorts), with an explicit
 * name/content separator, so the digest is stable across machines and cannot
 * be collided by moving content between files.
 */
export async function hashModule(root: string): Promise<string> {
    const hash = createHash("sha256")

    for (const file of ["module.config.ts", "package.json"]) {
        const text = await fsx.readText(join(root, file))
        if (text !== null) hash.update(`${file}\0${text}`)
    }

    for (const { relPath, absPath } of await fsx.walk(join(root, "src"))) {
        const text = await fsx.readText(absPath)
        if (text !== null) hash.update(`src/${relPath}\0${text}`)
    }

    return hash.digest("hex")
}

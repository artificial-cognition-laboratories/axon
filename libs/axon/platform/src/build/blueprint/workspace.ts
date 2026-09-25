import { dirname, join, resolve } from "node:path"
import { fsx } from "../../utils/fs"

/** Find the nearest repository workspace layer from an invocation directory. */
export function workspaceRoot(from: string): string | null {
    let dir = resolve(from)
    while (true) {
        const candidate = join(dir, ".agents")
        if (fsx.exists(candidate)) return candidate
        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

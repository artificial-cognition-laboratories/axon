import { join } from "node:path"
import { fsx } from "../../../utils/fs"
import type { ScanWarning } from "../types"

export type BootScan =
    | { boot: string; warnings: ScanWarning[] } // static — pre-read, rendered as-is
    | { bootFilePath: string; warnings: ScanWarning[] } // dynamic — the runtime renders this fresh, per tick
    | { warnings: ScanWarning[] } // no boot file at all

/**
 * Boot — the agent's base context: src/boot.md (static) or src/boot.vue
 * (dynamic). Static content lands on blueprint.boot pre-read. Dynamic boot
 * is a runtime concern — only the file path is noted here; the runtime
 * renders it fresh with live axon access, on its own schedule.
 */
export async function Boot(root: string): Promise<BootScan> {
    const vuePath = join(root, "src", "boot.vue")
    const mdPath = join(root, "src", "boot.md")

    if (fsx.exists(vuePath)) {
        return { bootFilePath: vuePath, warnings: [] }
    }

    if (fsx.exists(mdPath)) {
        // Null here means the file vanished between the exists() check and the
        // read — a race, not a state worth a warning. An unreadable file throws
        // (FILE_UNREADABLE) rather than arriving as null.
        const content = await fsx.readText(mdPath)
        if (content === null) return { warnings: [] }
        return { boot: content, warnings: [] }
    }

    return { warnings: [] }
}

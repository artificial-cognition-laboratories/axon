import { join, relative, sep } from "node:path"
import type { AxonBlueprint } from "@arcforge/types"
import { fsx } from "../../../utils/fs"
import { ProviderFile } from "../cognet"

/**
 * Providers — the agent's own, `providers/**\/*.provider.ts`, each named as a
 * grant names it: `providers/vision/features.provider.ts` is
 * `./providers/vision/features`, with what it implements and the engines it
 * needs — read, never imported: a provider is loaded by the runtime that
 * grants it, on the agent's side.
 */
export async function Providers(root: string): Promise<AxonBlueprint["serviceProviders"]> {
    const dir = join(root, "providers")
    if (!fsx.exists(dir)) return []
    const found = await fsx.walk(dir, { skipDirs: ["node_modules"] })
    return found
        .filter(file => file.relPath.endsWith(".provider.ts"))
        .map(file => ({
            name: `./providers/${relative(dir, file.absPath).split(sep).join("/").slice(0, -".provider.ts".length)}`,
            filePath: file.absPath,
            ...ProviderFile({ filePath: file.absPath }).read(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
}

import type { ProviderEntry } from "@arcforge/types"
import type { ProfileConfigResult } from "../build/extensions"

/** Reads the active machine policy without turning a broken config into account discovery. */
export function ProfileProviders(opts: {
    root(): string | undefined
    read(root: string): Promise<ProfileConfigResult>
}) {
    return {
        async read(): Promise<readonly ProviderEntry[] | undefined> {
            const root = opts.root()
            if (!root) return undefined
            const result = await opts.read(root)
            if (result.error) throw result.error
            return result.providers
        },
    }
}

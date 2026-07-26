import { err } from "@axon/err"
import type { AxonHandle, AxonPlugin } from "@arcforge/types"

type PluginsOpts = {
    entries: AxonPlugin[]
    /** THIS runtime's handle, passed to each plugin — never a global, so plugins stay bound to their own Axon() instance. */
    axon: AxonHandle
}

/**
 * Runs plugins in order, before routes are mounted. A throwing plugin aborts
 * boot — plugins are the one place in server/ where failure must be fatal,
 * not warned-and-skipped (unlike middleware/route loading upstream).
 */
export async function Plugins(opts: PluginsOpts) {
    for (const entry of opts.entries) {
        try {
            await entry.fn(opts.axon)
        } catch (cause) {
            throw err("PLUGIN_BOOT_FAILED", { detail: `plugin "${entry.name}" failed during boot`, context: { name: entry.name }, cause })
        }
    }
}

import { err } from "@arcforge/err"
import type { RunningWorld } from "../types"
import { TerrariaWorlds } from "./terraria-worlds"

export type TerrariaLabOpts = {
    /** The lab's state folder — staged mods, body save folders, the process ledger. */
    root: string
    installDir?: string
    userDir?: string
}

/**
 * TerrariaLab — the Terraria composition root.
 *
 * Every Terraria-specific concern lives below this root. It only establishes
 * the dependency graph and exposes the lab surface Fleet and modules use.
 */
export function TerrariaLab(opts: TerrariaLabOpts) {
    const worlds = TerrariaWorlds({ root: opts.root, installDir: opts.installDir, userDir: opts.userDir })

    return {
        state: worlds.state,
        scenarios: worlds.scenarios,
        runs: worlds.runs,
        start: worlds.start,
        attach: async (): Promise<RunningWorld> => { throw err("WORLD_REFUSED", { detail: "Terraria worlds can't be attached to: the lab serves its own" }) },
        stop: worlds.stop,
        restart: worlds.restart,
        logs: worlds.logs,
        act: worlds.act,
        history: worlds.history,
        bridge: worlds.bridge,
        bodies: worlds.bodies,
        dispose: worlds.dispose,
    }
}

export type TerrariaLabT = ReturnType<typeof TerrariaLab>

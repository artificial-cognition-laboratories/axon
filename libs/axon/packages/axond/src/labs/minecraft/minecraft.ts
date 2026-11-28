import { err } from "@arcforge/err"
import type { RunningWorld } from "../types"
import { MinecraftWorlds } from "./minecraft-worlds"

import type { LauncherT } from "../../launcher/index"

export type MinecraftLabOpts = { root: string; launcher: LauncherT; modSource?: string; java?: string }

/** MinecraftLab — the Minecraft composition root. */
export function MinecraftLab(opts: MinecraftLabOpts) {
    const worlds = MinecraftWorlds({ root: opts.root, launcher: opts.launcher, modSource: opts.modSource, java: opts.java })
    return {
        state: worlds.state,
        worlds: worlds.worlds,
        studio: worlds.studio,
        /** This lab's scenarios and runs, on the contract every lab answers. */
        scenarios: (input: { world: string }) => worlds.worlds.scenarios({ name: input.world }),
        runs: worlds.runs,
        bootstrap: worlds.bootstrap,
        start: worlds.start,
        attach: async (): Promise<RunningWorld> => { throw err("WORLD_REFUSED", { detail: "Minecraft worlds can't be attached to: the lab serves its own" }) },
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

export type MinecraftLabT = ReturnType<typeof MinecraftLab>

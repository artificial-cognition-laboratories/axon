import { join } from "node:path"
import type { LauncherT } from "../launcher/index"
import { AtriumLab } from "./atrium/index"
import { MinecraftLab } from "./minecraft/index"
import { TerrariaLab } from "./terraria/index"
import { LAB_IDS, type LabId, type LabT } from "./types"

export type LabsOpts = {
    /** Machine-wide lab state. Each lab owns one child folder named after it. */
    root: string
    /** Boots the agents a lab's scenario runs put in a world. */
    launcher: LauncherT
}

/**
 * Labs — every daemon-owned embodied environment on this machine, keyed by id.
 *
 * A REGISTRY rather than two named fields: every surface above this one has to
 * cover all of them — the daemon's verb dispatch, the client, Fleet's tree —
 * and each one that named the labs individually became a place to forget a lab.
 * `all` is what they iterate; `LAB_IDS` is what orders them.
 *
 * Deliberately not a generic "game engine" abstraction. The labs share a Fleet
 * surface, an RPC shape, and the body rig under `body/`, because worlds, bodies
 * and embodiment are genuinely common. Their installs, launchers and bridges
 * stay inside their own folders, where the differences actually are.
 */
export function Labs(opts: LabsOpts) {
    // Each lab under its own name. Terraria used to be handed the shared root
    // itself, so its mods/, bodies/ and pids.json sat beside Minecraft's folder
    // rather than inside one of its own — two labs at one level, one of them
    // colonising the parent.
    const terraria = TerrariaLab({ root: join(opts.root, "terraria") })
    const minecraft = MinecraftLab({ root: join(opts.root, "minecraft"), launcher: opts.launcher })
    const atrium = AtriumLab({ root: join(opts.root, "atrium") })

    const all: Record<LabId, LabT> = {
        terraria: terraria,
        minecraft: minecraft,
        atrium: atrium,
    }

    return {
        all: all,

        /** Daemon shutdown: every lab stops what it started. */
        async dispose(): Promise<void> {
            await Promise.all(LAB_IDS.map(id => all[id].dispose()))
        },
    }
}

export type LabsT = ReturnType<typeof Labs>

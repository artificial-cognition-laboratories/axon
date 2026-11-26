import { join } from "node:path"
import type { LauncherT } from "../launcher/index"
import { TerraverseLab } from "./terraverse/index"
import { LAB_IDS, type LabId, type LabT } from "./types"

export type LabsOpts = {
    /** Machine-wide lab state. Each lab owns one child folder named after it. */
    root: string
    /** Boots the agents a lab's scenario runs put in a world. Minecraft's, while it is registered. */
    launcher: LauncherT
    /** Which build of axond this is: an installed one runs installed games, one from source their checkouts. */
    build: "production" | "development"
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
    // Each lab under its own name. Minecraft and Terraria are in the tree,
    // unregistered: MinecraftLab({ root: join(opts.root, "minecraft"), launcher:
    // opts.launcher }) and TerrariaLab({ root: join(opts.root, "terraria") }).
    const terraverse = TerraverseLab({ root: join(opts.root, "terraverse"), build: opts.build })

    const all: Record<LabId, LabT> = {
        terraverse: terraverse,
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

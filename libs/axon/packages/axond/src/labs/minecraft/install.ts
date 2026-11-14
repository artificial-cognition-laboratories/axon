import { existsSync } from "node:fs"
import { join } from "node:path"
import { err } from "@arcforge/err"

export type InstallOpts = {
    root: string
    modSource?: string
}

/**
 * Install — all paths a managed Minecraft lab owns.
 *
 * A normal launcher installation is deliberately not used as the server
 * install. The daemon owns a Fabric server and each managed client profile;
 * the person's launcher remains their own client, untouched.
 *
 * Java is deliberately NOT here: which JDK can run a given Minecraft is a
 * version-specific question and `Jvm` owns it, so there is one answer rather
 * than a path check here and a version check there.
 *
 * The mod SOURCE is the one path the daemon cannot derive: it is a working
 * copy in somebody's checkout, and a library that hardcoded a path into a
 * home directory would be wrong on every other machine. So it is a fixed
 * location INSIDE the lab root, linked to the checkout — the same contract
 * Terraria already uses through tModLoader's `ModSources/AxonT` symlink, and
 * `problem()` says so when it is absent.
 */
export function Install(opts: InstallOpts) {
    const modSource = opts.modSource ?? process.env.AXON_MINECRAFT_MOD_DIR ?? join(opts.root, "AxonM")
    const server = opts.root
    const stagedMod = join(server, "mods", "AxonM.jar")

    function problem(): string | null {
        if (!existsSync(join(modSource, "gradlew"))) return `no AxonM Gradle project at ${modSource} — link it to your checkout's registry/modules/minecraft/mod (or set AXON_MINECRAFT_MOD_DIR)`
        return null
    }

    return {
        modSource: modSource,
        server: server,
        worlds: join(server, "worlds"),
        lab: {
            root: server,
            mods: join(server, "mods"),
            stagedMod: stagedMod,
            bodies: join(server, "bodies"),
            pids: join(server, "pids.json"),
        },
        problem: problem,
        require(): void {
            const missing = problem()
            if (missing) throw err("WORLD_INSTALL_MISSING", { detail: missing })
        },
    }
}

export type InstallT = ReturnType<typeof Install>

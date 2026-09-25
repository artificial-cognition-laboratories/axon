import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { err } from "@arcforge/err"

export type InstallOpts = {
    /** The lab's own state: staged mods, body save folders, logs. */
    root: string
    /** tModLoader's install folder (the Steam app). */
    installDir?: string
    /** tModLoader's user folder (Worlds, Players, ModSources, Mods). */
    userDir?: string
}

/**
 * Install — where everything a world needs is, and whether it is there.
 *
 * The one place paths are decided. Every other leaf asks this rather than
 * joining its own, so moving tModLoader is one setting and never a hunt.
 *
 * The lab keeps its OWN copy of the mod (`mods/`) rather than loading the one
 * tModLoader builds into. A running game holds its .tmod open, and building
 * over a held file fails — so a world loading the build output would make
 * "rebuild the mod" impossible while the lab is up, which is exactly when it
 * is wanted.
 */
export function Install(opts: InstallOpts) {
    const installDir = opts.installDir ?? process.env.TML_INSTALL_DIR ?? join(homedir(), ".local", "share", "Steam", "steamapps", "common", "tModLoader")
    const userDir = opts.userDir ?? process.env.TML_USER_DIR ?? join(homedir(), ".local", "share", "Terraria", "tModLoader")

    function problem(): string | null {
        if (!existsSync(join(installDir, "tModLoader.dll"))) return `tModLoader is not installed at ${installDir} (set TML_INSTALL_DIR)`
        if (!existsSync(join(installDir, "dotnet", "dotnet"))) return `tModLoader's bundled dotnet is missing from ${installDir}/dotnet`
        if (!Bun.which("Xvfb")) return "Xvfb is not installed — bodies render to a virtual display (install xorg-server-xvfb)"
        if (!Bun.which("ffmpeg")) return "ffmpeg is not installed — bodies capture their frames and audio with it"
        // Checked here rather than at boot: a body gets its own null sink for
        // ears, exactly as it gets a virtual display for eyes, and discovering
        // that three minutes into a client launch names the wrong cause.
        if (!Bun.which("pactl")) return "pactl is not installed — bodies hear through a virtual audio sink (install pipewire-pulse or pulseaudio-utils)"
        return null
    }

    return {
        installDir: installDir,
        userDir: userDir,
        /** The dotnet tModLoader ships with — the runtime its own launchers use. */
        dotnet: join(installDir, "dotnet", "dotnet"),
        worldsDir: join(userDir, "Worlds"),
        modSource: join(userDir, "ModSources", "AxonT"),
        builtMod: join(userDir, "Mods", "AxonT.tmod"),

        lab: {
            root: opts.root,
            mods: join(opts.root, "mods"),
            stagedMod: join(opts.root, "mods", "AxonT.tmod"),
            bodies: join(opts.root, "bodies"),
            serverSave: join(opts.root, "server"),
            pids: join(opts.root, "pids.json"),
        },

        /** Null when a world can run here; otherwise what is missing, said plainly. */
        problem: problem,

        /** Throws WORLD_INSTALL_MISSING naming what is absent. */
        require(): void {
            const missing = problem()
            if (missing) throw err("WORLD_INSTALL_MISSING", { detail: missing })
        },

        /**
         * What the installed tModLoader has already shown its user — the keys
         * that decide whether a fresh client stops on a first-run screen.
         *
         * Read from the user's own config rather than written as constants,
         * because they name the installed VERSION: a hardcoded one is correct
         * until the next Steam update, then every body boots to "Welcome to
         * tModLoader" and waits for a click.
         */
        seenVersions(): Record<string, unknown> {
            const path = join(userDir, "config.json")
            const keys = ["LastLaunchedVersion", "LastLaunchedTModLoaderVersion", "LatestNewsTimestamp"] as const
            let config: Record<string, unknown>
            try {
                config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
            } catch (cause) {
                throw err("WORLD_INSTALL_MISSING", { detail: `cannot read ${path} — launch tModLoader once yourself so it records its version`, cause: cause })
            }
            const missing = keys.filter(key => config[key] === undefined || config[key] === null)
            if (missing.length > 0) {
                throw err("WORLD_INSTALL_MISSING", { detail: `${path} has no ${missing.join(", ")} — launch tModLoader once yourself so it records them` })
            }
            return Object.fromEntries(keys.map(key => [key, config[key]]))
        },

        worldPath(name: string): string {
            return join(userDir, "Worlds", `${name}.wld`)
        },
    }
}

export type InstallT = ReturnType<typeof Install>

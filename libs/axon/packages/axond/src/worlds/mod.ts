import { existsSync, statSync } from "node:fs"
import { copyFile, mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { InstallT } from "./install"
import type { ModState } from "./types"

export type ModOpts = {
    install: InstallT
}

/**
 * Mod — the AxonT build: making it, and handing the lab its own copy.
 *
 * Built by tModLoader's own toolchain (`dotnet build` in the source folder —
 * its targets file packages the .tmod), so there is no second build recipe to
 * drift from the one the game uses.
 */
export function Mod(opts: ModOpts) {
    const install = opts.install

    async function state(): Promise<ModState> {
        const source = existsSync(install.modSource) ? install.modSource : null
        const built = existsSync(install.builtMod) ? statSync(install.builtMod).mtimeMs : null
        const staged = existsSync(install.lab.stagedMod) ? statSync(install.lab.stagedMod).mtimeMs : null
        const edited = source ? await newest(join(source, "src")) : null

        return {
            source: source,
            built: built === null ? null : { path: install.builtMod, at: new Date(built).toISOString() },
            staged: staged === null ? null : { at: new Date(staged).toISOString() },
            stale: (edited !== null && built !== null && edited > built) || (built !== null && staged !== null && built > staged),
        }
    }

    return {
        state: state,

        /**
         * Build AxonT. Fails loudly with the compiler's output.
         *
         * tModLoader refuses to build over a .tmod a running game has open
         * (TML003) — the user's own client, typically. That is said in words,
         * because the raw error is a stack trace about file handles.
         */
        async build(): Promise<ModState> {
            if (!existsSync(install.modSource)) {
                throw err("WORLD_MOD_BUILD_FAILED", { detail: `no AxonT source at ${install.modSource} — link the mod into tModLoader's ModSources` })
            }
            const proc = Bun.spawn(["dotnet", "build", "-nologo"], { cwd: install.modSource, stdout: "pipe", stderr: "pipe" })
            const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
            if (code !== 0) {
                const output = `${stdout}${stderr}`
                const held = output.includes("TML003")
                throw err("WORLD_MOD_BUILD_FAILED", {
                    detail: held
                        ? "a running tModLoader has AxonT.tmod open — close your own client (or disable AxonT in it) and build again"
                        : output.split("\n").filter(line => /error/i.test(line)).slice(0, 20).join("\n") || output.slice(-2000),
                })
            }
            return await state()
        },

        /**
         * Copy the build into the lab's mods folder, with AxonT enabled.
         *
         * Called before a world starts, so the server and every body load one
         * identical copy — tModLoader refuses a client whose mods differ from
         * the server's.
         */
        async stage(): Promise<void> {
            if (!existsSync(install.builtMod)) {
                throw err("WORLD_MOD_MISSING", { detail: `expected ${install.builtMod}` })
            }
            await mkdir(install.lab.mods, { recursive: true })
            await copyFile(install.builtMod, install.lab.stagedMod)
            await Bun.write(join(install.lab.mods, "enabled.json"), JSON.stringify(["AxonT"], null, 2) + "\n")
        },
    }
}

export type ModT = ReturnType<typeof Mod>

/** The newest modification time of any file under `dir`, or null when it does not exist. */
async function newest(dir: string): Promise<number | null> {
    if (!existsSync(dir)) return null
    let latest = 0
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue
        latest = Math.max(latest, (await stat(join(entry.parentPath, entry.name))).mtimeMs)
    }
    return latest
}

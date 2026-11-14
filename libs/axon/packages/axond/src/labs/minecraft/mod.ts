import { existsSync, statSync } from "node:fs"
import { copyFile, mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { BridgeState } from "../types"
import type { InstallT } from "./install"

export type ModOpts = { install: InstallT }

/** AxonM's Fabric build and the daemon-owned artifact used by every host. */
export function Mod(opts: ModOpts) {
    const install = opts.install

    async function state(): Promise<BridgeState> {
        const source = existsSync(install.modSource) ? install.modSource : null
        const artifact = join(install.modSource, "build", "libs", "axonm.jar")
        const built = existsSync(artifact) ? statSync(artifact).mtimeMs : null
        const staged = existsSync(install.lab.stagedMod) ? statSync(install.lab.stagedMod).mtimeMs : null
        const edited = source ? await newest(join(source, "src")) : null
        return {
            name: "AxonM",
            source: source,
            built: built === null ? null : { path: artifact, at: new Date(built).toISOString() },
            staged: staged === null ? null : { at: new Date(staged).toISOString() },
            stale: (edited !== null && built !== null && edited > built) || (built !== null && staged !== null && built > staged),
        }
    }

    return {
        state: state,
        async build(): Promise<BridgeState> {
            if (!existsSync(join(install.modSource, "gradlew"))) {
                throw err("WORLD_MOD_BUILD_FAILED", { detail: `no AxonM Gradle project at ${install.modSource} (set AXON_MINECRAFT_MOD_DIR)` })
            }
            const proc = Bun.spawn(["./gradlew", "build", "--no-daemon"], { cwd: install.modSource, stdout: "pipe", stderr: "pipe" })
            const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
            if (code !== 0) throw err("WORLD_MOD_BUILD_FAILED", { detail: `${stdout}${stderr}`.slice(-4_000) })
            return await state()
        },
        async stage(): Promise<void> {
            const artifact = join(install.modSource, "build", "libs", "axonm.jar")
            if (!existsSync(artifact)) throw err("WORLD_MOD_MISSING", { detail: `expected ${artifact} — build AxonM first` })
            await mkdir(install.lab.mods, { recursive: true })
            await copyFile(artifact, install.lab.stagedMod)
        },
    }
}

export type ModT = ReturnType<typeof Mod>

async function newest(dir: string): Promise<number | null> {
    if (!existsSync(dir)) return null
    let latest = 0
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue
        latest = Math.max(latest, (await stat(join(entry.parentPath, entry.name))).mtimeMs)
    }
    return latest
}

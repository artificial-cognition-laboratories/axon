import { existsSync, statSync } from "node:fs"
import { copyFile, mkdir, readdir, rename, stat } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { BridgeState } from "../types"

export type BinaryOpts = {
    /** The lab's state folder: the staged binary lives in `bin/`. */
    root: string
    /** The Atrium Cargo project — `apps/atrium` in a checkout. Default: AXON_ATRIUM_DIR, else `<root>/Atrium`, linked to it. */
    source?: string
}

/**
 * Binary — the `atrium` executable every world of this lab runs: built from
 * its Cargo project, then staged into the lab, so a rebuild never swaps the
 * file under a world that is running it. Atrium's "bridge", as the lab
 * contract has one: what the source is, what was built, what is loaded.
 *
 * The source is the one path the daemon cannot derive — a working copy in
 * somebody's checkout — so, as Minecraft's mod is, it is a fixed place in the
 * lab root linked to the checkout, and `problem()` says so when it is absent.
 */
export function Binary(opts: BinaryOpts) {
    const source = opts.source ?? process.env.AXON_ATRIUM_DIR ?? join(opts.root, "Atrium")
    const built = join(source, "target", "release", "atrium")
    const staged = join(opts.root, "bin", "atrium")

    function problem(): string | null {
        if (!existsSync(join(source, "Cargo.toml"))) return `no Atrium Cargo project at ${source} — link it to your checkout's apps/atrium (or set AXON_ATRIUM_DIR)`
        if (!existsSync(built) && !existsSync(staged)) return `Atrium is not built — build it from the lab (cargo build --release in ${source})`
        return null
    }

    async function state(): Promise<BridgeState> {
        const project = existsSync(join(source, "Cargo.toml")) ? source : null
        const builtAt = existsSync(built) ? statSync(built).mtimeMs : null
        const stagedAt = existsSync(staged) ? statSync(staged).mtimeMs : null
        const edited = project ? await newest(join(project, "src")) : null
        return {
            name: "atrium",
            source: project,
            built: builtAt === null ? null : { path: built, at: new Date(builtAt).toISOString() },
            staged: stagedAt === null ? null : { at: new Date(stagedAt).toISOString() },
            stale: (edited !== null && builtAt !== null && edited > builtAt) || (builtAt !== null && stagedAt !== null && builtAt > stagedAt),
        }
    }

    async function stage(): Promise<void> {
        if (!existsSync(built)) {
            if (existsSync(staged)) return
            throw err("WORLD_MOD_MISSING", { detail: `expected ${built} — build Atrium first` })
        }
        if (existsSync(staged) && statSync(staged).mtimeMs >= statSync(built).mtimeMs) return
        await mkdir(join(opts.root, "bin"), { recursive: true })
        // Copied beside, then renamed over: a world starting this moment never runs half a file.
        const partial = `${staged}.partial`
        await copyFile(built, partial)
        await rename(partial, staged)
    }

    return {
        /** The staged executable a world runs, and the library verbs use. */
        path: staged,
        problem: problem,
        state: state,
        async build(): Promise<BridgeState> {
            if (!existsSync(join(source, "Cargo.toml"))) throw err("WORLD_MOD_BUILD_FAILED", { detail: `no Atrium Cargo project at ${source} (set AXON_ATRIUM_DIR)` })
            const proc = Bun.spawn(["cargo", "build", "--release"], { cwd: source, stdout: "pipe", stderr: "pipe" })
            const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
            if (code !== 0) throw err("WORLD_MOD_BUILD_FAILED", { detail: `${stdout}${stderr}`.slice(-4_000) })
            await stage()
            return await state()
        },
        /** The newest build staged, when there is one newer than what is staged. Throws when nothing was ever built. */
        stage: stage,
    }
}

export type BinaryT = ReturnType<typeof Binary>

/** The newest file's modification under `dir`, ms; null when there is none. */
async function newest(dir: string): Promise<number | null> {
    if (!existsSync(dir)) return null
    let latest = 0
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue
        latest = Math.max(latest, (await stat(join(entry.parentPath, entry.name))).mtimeMs)
    }
    return latest
}

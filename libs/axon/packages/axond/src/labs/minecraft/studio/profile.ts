import { existsSync } from "node:fs"
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AuthorModsT } from "./mods"

/**
 * The authoring client's game folder: a copy of the provisioned instance, with
 * AxonM and the building mods in it, and — the point of it — its `saves`
 * folder IS the lab's worlds. Singleplayer lists the lab's worlds, Create New
 * World makes one, and the lab's server runs the same folder an author built.
 */
export function Profile(opts: { dir: string; template: string; stagedMod: string; worlds: string; mods: AuthorModsT }) {
    const gameDir = join(opts.dir, "game")

    /** A fresh copy of the instance, once; never refreshed over a person's settings. */
    async function copied(): Promise<void> {
        if (existsSync(gameDir)) return
        const staging = join(opts.dir, "game.preparing")
        await rm(staging, { recursive: true, force: true })
        await mkdir(staging, { recursive: true })
        try {
            if (existsSync(opts.template)) {
                await cp(opts.template, staging, { recursive: true, filter: source => !/\/(logs|saves|crash-reports)(\/|$)/.test(source) })
            }
            await rename(staging, gameDir)
        } catch (cause) {
            await rm(staging, { recursive: true, force: true })
            throw cause
        }
    }

    /** `saves` as a link to the lab's worlds. A real folder holding worlds is never deleted: it is refused, by name. */
    async function linked(): Promise<void> {
        const saves = join(gameDir, "saves")
        await mkdir(opts.worlds, { recursive: true })
        const found = await lstat(saves).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return null
            throw cause
        })
        if (found?.isSymbolicLink()) {
            if (await readlink(saves) === opts.worlds) return
            await rm(saves)
        } else if (found) {
            const held = await readdir(saves)
            if (held.length > 0) throw new Error(`The authoring client's ${saves} holds ${held.join(", ")}; move them into the lab's worlds (${opts.worlds}) before it can author there`)
            await rmdir(saves)
        }
        await symlink(opts.worlds, saves, "dir")
    }

    /** Sets each of `settings` in options.txt, leaving every other line as the person left it. */
    async function options(settings: Record<string, string>): Promise<void> {
        const file = join(gameDir, "options.txt")
        const lines = existsSync(file) ? (await readFile(file, "utf-8")).trimEnd().split("\n") : []
        const required = new Map(Object.entries(settings))
        const updated = lines.filter(line => line.length > 0).map(line => {
            const separator = line.indexOf(":")
            if (separator < 0) throw new Error(`Malformed authoring options.txt line: ${line}`)
            const key = line.slice(0, separator)
            const value = required.get(key)
            if (value === undefined) return line
            required.delete(key)
            return `${key}:${value}`
        })
        for (const [key, value] of required) updated.push(`${key}:${value}`)
        await writeFile(file, updated.join("\n") + "\n")
    }

    return {
        gameDir: gameDir,
        /** Ready to launch, with `settings` in its options. */
        async prepare(settings: Record<string, string>): Promise<void> {
            await mkdir(opts.dir, { recursive: true })
            await copied()
            await linked()
            const mods = join(gameDir, "mods")
            await mkdir(mods, { recursive: true })
            await copyFile(opts.stagedMod, join(mods, "AxonM.jar"))
            await opts.mods.install(mods)
            await options(settings)
        },
    }
}

export type ProfileT = ReturnType<typeof Profile>

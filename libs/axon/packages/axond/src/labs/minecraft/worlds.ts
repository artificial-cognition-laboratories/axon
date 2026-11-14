import { existsSync } from "node:fs"
import { cp, lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { WorldInfo } from "../types"

export type MinecraftWorldSource = "lab" | "minecraft" | "prism"
export type MinecraftDifficulty = "peaceful" | "easy" | "normal" | "hard"

/** The saves Fleet may offer, and the managed copies the server may start. */
export function Worlds(opts: { managed: string; root: string; prismGame: string; minecraftSaves?: string }) {
    const sources = {
        minecraft: opts.minecraftSaves ?? join(homedir(), ".minecraft", "saves"),
        prism: join(opts.prismGame, "saves"),
    }

    function name(input: string): string {
        if (!input || input.length > 120 || input === "." || input === ".." || /[\/\\\x00-\x1f]/.test(input)) {
            throw new Error(`Invalid Minecraft world name: ${JSON.stringify(input)}`)
        }
        return input
    }

    async function entries(root: string, source: MinecraftWorldSource): Promise<WorldInfo[]> {
        if (!existsSync(root)) return []
        const found = await readdir(root, { withFileTypes: true })
        const worlds: WorldInfo[] = []
        for (const entry of found) {
            if (!entry.isDirectory()) continue
            const path = join(root, entry.name)
            // The lab may have a newly created, empty world. A personal save
            // must have level.dat before it can be offered for import.
            if (source !== "lab" && !existsSync(join(path, "level.dat"))) continue
            const info = await stat(path)
            worlds.push({ name: entry.name, path: path, modifiedAt: info.mtime.toISOString(), source: source })
        }
        return worlds.sort((a, b) => a.name.localeCompare(b.name))
    }

    /**
     * The lab's own setting for a world: how dangerous it is. Everything else a
     * lab world is lives inside the save itself (`axon/`), written by the game.
     */
    async function settings(worldName: string): Promise<{ difficulty: MinecraftDifficulty }> {
        const file = join(opts.managed, name(worldName), ".axon-world.json")
        if (!existsSync(file)) return { difficulty: "peaceful" }
        const data: unknown = JSON.parse(await readFile(file, "utf-8"))
        if (typeof data !== "object" || data === null || !("difficulty" in data) || !isDifficulty(data.difficulty)) {
            throw new Error(`Invalid Minecraft lab settings at ${file}`)
        }
        return { difficulty: data.difficulty }
    }

    return {
        async path(input: { name: string }): Promise<string> {
            const worldName = name(input.name)
            const directory = join(opts.managed, worldName)
            if (!(await lstat(directory)).isDirectory()) throw new Error(`${worldName} is not a managed Minecraft world`)
            return directory
        },
        /** The scenarios set up in a world, by name. Their contents are AxonM's to read; only the names are the lab's. */
        async scenarios(input: { name: string }): Promise<string[]> {
            const directory = join(opts.managed, name(input.name), "axon", "scenarios")
            if (!existsSync(directory)) return []
            return (await readdir(directory)).filter(file => file.endsWith(".json")).map(file => file.slice(0, -".json".length)).sort()
        },
        /**
         * The process holding a world open, or null. Minecraft locks `session.lock` for as long as a world is open —
         * in a person's singleplayer game as much as on a server — and the kernel's lock table is the one place that
         * says so for any process.
         */
        async user(input: { name: string }): Promise<number | null> {
            const lock = join(opts.managed, name(input.name), "session.lock")
            const proc = Bun.spawn(["lslocks", "--json", "--output", "PID,PATH"], { stdout: "pipe", stderr: "pipe" })
            const [code, out, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
            if (code !== 0) throw new Error(`Could not read the lock table to see whether ${input.name} is open: lslocks exited ${code}: ${error.trim()}`)
            const table: unknown = JSON.parse(out)
            if (typeof table !== "object" || table === null || !("locks" in table) || !Array.isArray(table.locks)) throw new Error("lslocks returned no lock table")
            const held = table.locks.find((row: { pid?: unknown; path?: unknown }) => row.path === lock)
            return held && typeof held.pid === "number" ? held.pid : null
        },
        async difficulty(worldName: string): Promise<MinecraftDifficulty> { return (await settings(worldName)).difficulty },
        async setDifficulty(input: { name: string; difficulty: MinecraftDifficulty }): Promise<void> {
            const worldName = name(input.name)
            const directory = join(opts.managed, worldName)
            if (!(await lstat(directory)).isDirectory()) throw new Error(`${worldName} is not a managed Minecraft world`)
            const file = join(directory, ".axon-world.json")
            const staging = join(directory, `.axon-world-${randomUUID()}.tmp`)
            await writeFile(staging, JSON.stringify({ difficulty: input.difficulty }) + "\n")
            await rename(staging, file)
        },
        async list(): Promise<WorldInfo[]> {
            const [managed, minecraft, prism] = await Promise.all([
                entries(opts.managed, "lab"),
                entries(sources.minecraft, "minecraft"),
                entries(sources.prism, "prism"),
            ])
            const names = new Set(managed.map(world => world.name))
            return [...managed, ...[...minecraft, ...prism].filter(world => {
                if (names.has(world.name)) return false
                names.add(world.name)
                return true
            })]
        },
        async import(input: { name: string; source: Exclude<MinecraftWorldSource, "lab"> }): Promise<void> {
            const worldName = name(input.name)
            const root = sources[input.source]
            if (!root) throw new Error(`Unknown Minecraft save source: ${input.source}`)
            const source = join(root, worldName)
            if (!(await lstat(source)).isDirectory() || !existsSync(join(source, "level.dat"))) {
                throw new Error(`${worldName} is not a Minecraft world in ${root}`)
            }
            const target = join(opts.managed, worldName)
            if (existsSync(target)) throw new Error(`World ${worldName} already exists in the lab`)
            await mkdir(opts.managed, { recursive: true })
            const staging = join(opts.root, `.import-${randomUUID()}`)
            try {
                await cp(source, staging, { recursive: true, force: false })
                if (existsSync(target)) throw new Error(`World ${worldName} was added while importing`)
                await rename(staging, target)
            } catch (cause) {
                // A failed copy is deliberately left at a named staging path
                // for inspection rather than quietly deleting partial data.
                throw new Error(`Could not import ${worldName}; partial copy is at ${staging}`, { cause: cause })
            }
        },
        async remove(input: { name: string }): Promise<string> {
            const worldName = name(input.name)
            const source = join(opts.managed, worldName)
            if (!(await lstat(source)).isDirectory()) throw new Error(`${worldName} is not a managed Minecraft world`)
            const archive = join(opts.root, "removed")
            await mkdir(archive, { recursive: true })
            const destination = join(archive, `${worldName}-${randomUUID()}`)
            await rename(source, destination)
            return destination
        },
    }
}

export type WorldsT = ReturnType<typeof Worlds>

function isDifficulty(value: unknown): value is MinecraftDifficulty {
    return value === "peaceful" || value === "easy" || value === "normal" || value === "hard"
}

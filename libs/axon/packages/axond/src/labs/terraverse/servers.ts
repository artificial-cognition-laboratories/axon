import { statSync } from "node:fs"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { WorldInfo } from "../types"
import type { TerraT } from "./terra"

/**
 * Servers — the worlds this lab can run: the player's own, as the game's Play list shows them.
 * terra says which (`terra worlds --json`): the home, the profile signed in to the game and its
 * worlds are terra's to know, so a second reader of them here would be a second answer.
 */
export function Servers(opts: { terra: TerraT }) {
    async function list(): Promise<WorldInfo[]> {
        const proc = Bun.spawn([opts.terra.path(), "worlds", "--json"], { stdout: "pipe", stderr: "pipe" })
        const [code, out, problem] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        if (code !== 0) throw err("WORLD_REFUSED", { detail: `terra worlds: ${problem.trim() || `exited ${code}`}` })
        return parsed(out).map(world => ({
            name: world.name,
            path: world.path,
            modifiedAt: statSync(join(world.path, "world.mt")).mtime.toISOString(),
            source: "lab" as const,
        }))
    }

    return { list: list }
}

export type ServersT = ReturnType<typeof Servers>

/** `terra worlds --json`, read strictly: a line that isn't it is terra and the lab disagreeing. */
function parsed(text: string): Array<{ name: string; path: string }> {
    let value: unknown
    try {
        value = JSON.parse(text.trim().split("\n").at(-1) ?? "")
    } catch {
        throw err("WORLD_REFUSED", { detail: `terra worlds said something that isn't JSON: ${text.slice(0, 200)}` })
    }
    const worlds = typeof value === "object" && value !== null && "worlds" in value ? value.worlds : null
    if (!Array.isArray(worlds)) throw err("WORLD_REFUSED", { detail: `terra worlds said no worlds: ${text.slice(0, 200)}` })
    return worlds.map(w => {
        const name = typeof w === "object" && w !== null && "name" in w ? w.name : null
        const path = typeof w === "object" && w !== null && "path" in w ? w.path : null
        if (typeof name !== "string" || typeof path !== "string") throw err("WORLD_REFUSED", { detail: `terra worlds listed a world without a name or path: ${JSON.stringify(w)}` })
        return { name: name, path: path }
    })
}

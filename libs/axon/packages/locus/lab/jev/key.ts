import { readFileSync } from "node:fs"
import { join } from "node:path"

/** The OpenRouter key, from the environment or the `.env` at `root` — never printed, never copied. */
export function openrouterKey(root: string): string {
    if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
    const line = readFileSync(join(root, ".env"), "utf8").split("\n").find(one => one.startsWith("OPENROUTER_API_KEY="))
    const value = line?.slice("OPENROUTER_API_KEY=".length).trim().replace(/^["']|["']$/g, "")
    if (!value) throw new Error(`no OPENROUTER_API_KEY in the environment or ${join(root, ".env")}`)
    return value
}

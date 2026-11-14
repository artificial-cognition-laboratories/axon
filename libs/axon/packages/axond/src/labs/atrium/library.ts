import { existsSync, statSync } from "node:fs"
import { err } from "@arcforge/err"
import type { Imported, LibraryEntry } from "../types"
import type { BinaryT } from "./binary"

export type LibraryOpts = {
    binary: BinaryT
    /** A library of its own — a test's. Absent: Atrium's own default, the one a person at a terminal uses too. */
    root?: string
}

/**
 * Library — the lab's bodies and worlds, as Atrium bakes and lists them.
 *
 * Every verb is Atrium's own CLI run against the lab's library: the layout
 * on disk is Atrium's to know, and a second reader of it here would be a
 * second answer to what the library holds.
 */
export function Library(opts: LibraryOpts) {
    /** The arguments that point Atrium at this lab's library — none, for Atrium's own. */
    const library = opts.root ? ["--library", opts.root] : []

    async function run(args: string[]): Promise<string> {
        await opts.binary.stage()
        const proc = Bun.spawn([opts.binary.path, ...library, ...args], { stdout: "pipe", stderr: "pipe" })
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        if (code !== 0) throw err("WORLD_REFUSED", { detail: stderr.trim().replace(/^atrium: /, "") || `atrium ${args[0]} exited ${code}` })
        return stdout
    }

    return {
        /** What points an `atrium` command at this library. */
        args: library,

        async list(): Promise<LibraryEntry[]> {
            const out = await run(["list"])
            return out.split("\n").filter(Boolean).map(line => entry(line))
        },

        /** A body (MJCF, URDF) or a world (glTF, OBJ, USD, a Habitat scene, an MJCF scene) baked into the library, from a file on this machine. */
        async import(input: { file: string; name?: string; as?: "body" | "world"; props?: Array<{ node: string; mass?: number }>; replace?: boolean }): Promise<Imported> {
            if (!existsSync(input.file) || !statSync(input.file).isFile()) throw err("WORLD_NOT_FOUND", { detail: `${input.file} is not a file on this machine` })
            const args = ["import", input.file]
            if (input.name) args.push("--name", input.name)
            if (input.as) args.push("--as", input.as)
            if (input.replace) args.push("--replace")
            for (const prop of input.props ?? []) args.push("--prop", prop.mass === undefined ? prop.node : `${prop.node}=${prop.mass}`)
            const out = await run(args)
            return imported(out)
        },
    }
}

export type LibraryT = ReturnType<typeof Library>

/** A line of `atrium list`, checked: Atrium's output is a boundary. */
function entry(line: string): LibraryEntry {
    const value: unknown = JSON.parse(line)
    if (typeof value !== "object" || value === null) throw err("WORLD_REFUSED", { detail: `atrium list said ${line}` })
    const fields = Object.fromEntries(Object.entries(value))
    const { kind, name, source, path } = fields
    if ((kind !== "body" && kind !== "world") || typeof name !== "string" || typeof source !== "string" || (path !== null && typeof path !== "string")) {
        throw err("WORLD_REFUSED", { detail: `atrium list said ${line}` })
    }
    return { kind: kind, name: name, source: source, path: path }
}

function imported(out: string): Imported {
    const value: unknown = JSON.parse(out.trim())
    const fields = typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}
    const { kind, name, dir } = fields
    if ((kind !== "body" && kind !== "world") || typeof name !== "string" || typeof dir !== "string") throw err("WORLD_REFUSED", { detail: `atrium import said ${out}` })
    return { kind: kind, name: name, dir: dir }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { err } from "@arcforge/err"

type Entry = { number: number; signature: string; removed?: true }
type Image = { version: 1; messages: Record<string, Record<string, Entry>> }

/** Protobuf numbers and tombstones retained in the agent frame between prepares. */
export function Lock(opts: { path: string }) {
    let loaded: Image | null = null
    const image = (): Image => {
        if (loaded) return loaded
        try { loaded = existsSync(opts.path) ? JSON.parse(readFileSync(opts.path, "utf8")) as Image : { version: 1, messages: {} } }
        catch (cause) { throw err("COGNET_SCHEMA_INVALID", { detail: `${opts.path}: invalid JSON in component schema lock: ${String(cause)}` }) }
        if (loaded.version !== 1 || !loaded.messages || typeof loaded.messages !== "object" || Array.isArray(loaded.messages)) throw err("COGNET_SCHEMA_INVALID", { detail: `${opts.path}: invalid component schema lock` })
        for (const [owner, fields] of Object.entries(loaded.messages)) {
            if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw err("COGNET_SCHEMA_INVALID", { detail: `${opts.path}: invalid fields for ${owner}` })
            const used = new Set<number>()
            for (const [name, field] of Object.entries(fields)) {
                if (!field || !Number.isSafeInteger(field.number) || field.number < 1 || typeof field.signature !== "string" || used.has(field.number)) throw err("COGNET_SCHEMA_INVALID", { detail: `${opts.path}: invalid field ${owner}.${name}` })
                used.add(field.number)
            }
        }
        return loaded
    }
    return {
        field(owner: string, name: string, signature: string): number {
            const fields = image().messages[owner] ??= {}
            const current = fields[name]
            if (current?.removed) throw err("COGNET_SCHEMA_INVALID", { detail: `${owner}.${name}: this field was removed; give the new field a new name` })
            if (current && current.signature !== signature) throw err("COGNET_SCHEMA_INVALID", { detail: `${owner}.${name}: wire type changed from ${current.signature} to ${signature}; migrate the component explicitly` })
            if (current) return current.number
            let next = Math.max(0, ...Object.values(fields).map(field => field.number)) + 1
            if (next >= 19000 && next <= 19999) next = 20000
            if (next > 536870911) throw err("COGNET_SCHEMA_INVALID", { detail: `${owner}: protobuf has no field numbers left` })
            fields[name] = { number: next, signature: signature }
            return next
        },
        finish(owner: string, active: string[]): number[] {
            const fields = image().messages[owner] ??= {}
            const present = new Set(active)
            for (const [name, entry] of Object.entries(fields)) if (!present.has(name)) entry.removed = true
            return Object.values(fields).filter(entry => entry.removed).map(entry => entry.number).sort((a, b) => a - b)
        },
        finishAll(active: string[]): void {
            const present = new Set(active)
            for (const [owner, fields] of Object.entries(image().messages)) {
                if (present.has(owner)) continue
                for (const entry of Object.values(fields)) entry.removed = true
            }
        },
        save(): void {
            const data = `${JSON.stringify(image(), null, 2)}\n`
            mkdirSync(dirname(opts.path), { recursive: true })
            if (!existsSync(opts.path) || readFileSync(opts.path, "utf8") !== data) writeFileSync(opts.path, data)
        },
    }
}

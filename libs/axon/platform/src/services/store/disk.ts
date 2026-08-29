import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Disk — the store's fs leaf. The ONLY code in the store that touches the
 * filesystem. Three primitives: json files, text files, jsonl logs.
 *
 * Absence is a valid state — get() returns null for missing files. Writes
 * are atomic (tmp + rename) so a crash never leaves a half-written record.
 */
export function Disk(opts: { root: string }) {
    const { root } = opts

    function abs(rel: string): string {
        return join(root, rel)
    }

    function writeAtomic(path: string, content: string): void {
        mkdirSync(dirname(path), { recursive: true })
        const tmp = path + ".tmp"
        writeFileSync(tmp, content, "utf-8")
        renameSync(tmp, path)
    }

    return {
        root,

        json<T>(rel: string) {
            const path = abs(rel)
            return {
                get(): T | null {
                    if (!existsSync(path)) return null
                    return JSON.parse(readFileSync(path, "utf-8")) as T
                },
                set(value: T): void {
                    writeAtomic(path, JSON.stringify(value, null, 2) + "\n")
                },
                /** Read-modify-write. Missing file starts from `initial`. */
                update(initial: T, fn: (current: T) => T): void {
                    const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : initial
                    writeAtomic(path, JSON.stringify(fn(current), null, 2) + "\n")
                },
                delete(): void {
                    rmSync(path, { force: true })
                },
            }
        },

        text(rel: string) {
            const path = abs(rel)
            return {
                get(): string | null {
                    return existsSync(path) ? readFileSync(path, "utf-8") : null
                },
                set(value: string): void {
                    writeAtomic(path, value)
                },
                delete(): void {
                    rmSync(path, { force: true })
                },
            }
        },

        jsonl<T>(rel: string) {
            const path = abs(rel)
            return {
                append(entry: T): void {
                    mkdirSync(dirname(path), { recursive: true })
                    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8")
                },
                read(): T[] {
                    if (!existsSync(path)) return []
                    return readFileSync(path, "utf-8")
                        .split("\n")
                        .filter(line => line.trim())
                        .map(line => JSON.parse(line) as T)
                },
                delete(): void {
                    rmSync(path, { force: true })
                },
            }
        },

        /** Immediate child names of a directory. Missing dir = []. */
        list(rel: string): string[] {
            const path = abs(rel)
            return existsSync(path) ? readdirSync(path) : []
        },

        /** Remove a subtree. */
        remove(rel: string): void {
            rmSync(abs(rel), { recursive: true, force: true })
        },
    }
}

export type DiskT = ReturnType<typeof Disk>

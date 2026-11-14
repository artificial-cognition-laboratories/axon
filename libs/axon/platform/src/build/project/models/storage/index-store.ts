import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { lock } from "proper-lockfile"
import { fsx } from "../../../../utils/fs"

/** Serialize model-index mutations across handles and processes; readers see atomic snapshots. */
export function Index<T>(opts: { root: string }) {
    const path = join(opts.root, "index.json")
    async function read(): Promise<Record<string, T>> { return await fsx.readJson<Record<string, T>>(path) ?? {} }
    async function update<R>(mutate: (index: Record<string, T>) => Promise<R>): Promise<R> {
        await mkdir(opts.root, { recursive: true })
        const release = await lock(path, { realpath: false, stale: 10_000, update: 2000,
            retries: { retries: 100, minTimeout: 10, maxTimeout: 100, factor: 1.1 } })
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
            const index = await read()
            const result = await mutate(index)
            await writeFile(temporary, JSON.stringify(index, null, 4))
            await rename(temporary, path)
            return result
        } finally {
            try { await rm(temporary, { force: true }) } finally { await release() }
        }
    }
    return { read: read, update: update }
}

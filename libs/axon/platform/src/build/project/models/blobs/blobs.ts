import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { StoredModel } from "../store"

/** Stream verified bytes into the content-addressed store with bounded memory. */
export function Blobs(opts: { root: string }) {
    async function receive(input: {
        filename: string
        body: ReadableStream<Uint8Array>
        expected?: string
        signal?: AbortSignal
        progress?(received: number): void
    }): Promise<StoredModel> {
        await mkdir(opts.root, { recursive: true })
        const temporary = join(opts.root, `.incoming-${randomUUID()}`)
        const file = await open(temporary, "wx")
        const reader = input.body.getReader()
        const hash = createHash("sha256")
        let bytes = 0
        try {
            while (true) {
                input.signal?.throwIfAborted()
                const chunk = await reader.read()
                if (chunk.done) break
                hash.update(chunk.value)
                let offset = 0
                while (offset < chunk.value.length) {
                    const result = await file.write(chunk.value, offset, chunk.value.length - offset)
                    if (result.bytesWritten <= 0) throw err("MODEL_FETCH_FAILED", { detail: "model file write made no progress" })
                    offset += result.bytesWritten
                }
                bytes += chunk.value.length
                input.progress?.(bytes)
            }
            input.signal?.throwIfAborted()
            const sha256 = hash.digest("hex")
            if (input.expected && input.expected !== sha256) throw err("MODEL_HASH_MISMATCH", { detail: `${input.filename}: expected ${input.expected}, received ${sha256}` })
            const directory = join(opts.root, sha256)
            await mkdir(directory, { recursive: true })
            await file.sync()
            await file.close()
            const path = join(directory, input.filename)
            input.signal?.throwIfAborted()
            await rename(temporary, path)
            return { path: path, sha256: sha256, bytes: bytes }
        } finally {
            try { await reader.cancel() } finally {
                reader.releaseLock()
                await file.close()
                await rm(temporary, { force: true })
            }
        }
    }
    return { receive: receive }
}

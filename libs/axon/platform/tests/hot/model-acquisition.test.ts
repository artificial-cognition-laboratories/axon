import { test, expect, afterEach } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { Fetch, ModelStore, parseModel } from "../../src/build/project"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

test("simultaneous index writers retain every model and its traits", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-model-index-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const stores = Array.from({ length: 8 }, () => ModelStore({ root: root }))
    await Promise.all(stores.map(async (store, at) => {
        const stored = await store.put(`model${at}.gguf`, new TextEncoder().encode(`weight${at}`))
        const id = `hf:test/model${at}@main/model${at}.gguf`
        await store.remember(id, stored, `model${at}.gguf`)
        await store.describe(id, { capability: "chat", type: "generate", in: ["text"], out: ["text"] })
    }))
    const records = await ModelStore({ root: root }).list()
    expect(records).toHaveLength(8)
    expect(records.every(record => record.traits?.capability === "chat")).toBe(true)
})

test("streamed acquisition verifies the hash and publishes only a complete model", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-model-acquire-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const data = new TextEncoder().encode("GGUF verified bytes")
    const sha = createHash("sha256").update(data).digest("hex")
    const server = Bun.serve({ port: 0, fetch: request => request.method === "HEAD"
        ? new Response(null, { headers: { "x-linked-etag": sha } })
        : new Response(data) })
    cleanup.push(async () => { await server.stop(true) })
    const store = ModelStore({ root: root })
    const fetcher = Fetch({ store: store, fetch: (input, init) => fetch(server.url, init) })
    const model = parseModel("weight", "hf:test/chat@main/model.gguf")
    const result = await fetcher.file(model)
    expect(result.sha256).toBe(sha)
    expect((await store.list())[0]?.specifier).toBe("hf:test/chat@main/model.gguf")
    expect(await readdir(root)).not.toContain(".incoming")
})

test("cancelling a real transfer leaves no installed model or partial file", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-model-cancel-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    let timer: ReturnType<typeof setInterval> | undefined
    const server = Bun.serve({ port: 0, fetch: request => request.method === "HEAD" ? new Response(null) : new Response(new ReadableStream({
        start(controller) { timer = setInterval(() => controller.enqueue(new Uint8Array(1024)), 10) },
        cancel() { if (timer) clearInterval(timer) },
    })) })
    cleanup.push(async () => { if (timer) clearInterval(timer); await server.stop(true) })
    const store = ModelStore({ root: root })
    const fetcher = Fetch({ store: store, fetch: (input, init) => fetch(server.url, init) })
    const controller = new AbortController()
    await expect(fetcher.file(parseModel("weight", "hf:test/chat@main/model.gguf"), {
        signal: controller.signal,
        onProgress: progress => { if (progress.received > 0) controller.abort() },
    })).rejects.toThrow()
    expect(await store.list()).toEqual([])
    expect((await readdir(root)).some(name => name.startsWith(".incoming-"))).toBe(false)
})

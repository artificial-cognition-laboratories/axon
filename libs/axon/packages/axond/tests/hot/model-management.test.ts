import { test, expect, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Downloads } from "../../src/models/downloads"
import { Models, Adapters, Catalog } from "../../src/models"
import { Artifacts } from "../../src/models/catalog"
import { Machine } from "../../src/machine"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

test("cancelled downloads remain active until acquisition finishes cleaning up", async () => {
    const downloads = Downloads()
    let finish!: () => void
    const cleanup = new Promise<void>(resolve => { finish = resolve })
    const id = downloads.start("hf:test/chat", async (_report, signal) => {
        await cleanup
        signal.throwIfAborted()
    })
    expect(downloads.cancel(id)).toBe(true)
    expect(downloads.at(id)?.state).toBe("cancelling")
    expect(downloads.inFlight("hf:test/chat")?.id).toBe(id)
    expect(downloads.dismiss(id)).toBe(false)
    finish()
    await Bun.sleep(0)
    expect(downloads.at(id)?.state).toBe("cancelled")
    expect(downloads.inFlight("hf:test/chat")).toBeNull()
})

test("unloading is coalesced and blocks inference until disposal completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-unload-"))
    roots.push(root)
    let finish!: () => void
    const disposing = new Promise<void>(resolve => { finish = resolve })
    let disposals = 0
    const models = Models({ root: root, machine: Machine({ residencyRoot: join(root, "holds") }), adapters: Adapters([{
        runtime: "llama.cpp", claims: () => true,
        load: async () => ({ bytes: 1, engine: "generate", run: async () => "hello", unload: async () => { disposals++; await disposing } }),
    }]) })
    await models.load({ path: "test", model: "hf:test/chat", agent: "you", role: "manual" })
    const first = models.unload("hf:test/chat")
    const second = models.unload("hf:test/chat")
    await expect(models.run({ model: "hf:test/chat", input: "hi" })).rejects.toThrow("unloading")
    finish()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(disposals).toBe(1)
    expect(models.state().resident).toEqual([])
})

test("repository details preserve the selected revision and variant sizes", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-revision-"))
    roots.push(root)
    let requested = ""
    const remote = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        requested = String(input)
        return Response.json({ pipeline_tag: "text-generation", siblings: [{ rfilename: "chat-Q4.gguf", size: 123 }] })
    }, { preconnect: fetch.preconnect })
    const catalog = Catalog({ root: join(root, "catalog.json"), fetch: remote })
    const detail = await catalog.detail("hf:test/chat@release")
    expect(requested).toContain("/revision/release?blobs=true")
    expect(detail.id).toBe("hf:test/chat@release")
    expect(detail.sizes["chat-Q4.gguf"]).toBe(123)
})

test("ONNX acquisition and execution agree on the quantization", () => {
    const artifacts = Artifacts()
    const plan = artifacts.plan(["config.json", "tokenizer.json", "onnx/model_q4.onnx", "onnx/model_q4.onnx_data"])
    expect(plan?.files).toContain("onnx/model_q4.onnx_data")
    expect(artifacts.dtype(plan?.files ?? [])).toBe("q4")
    expect(() => artifacts.dtype(["onnx/model.onnx", "onnx/model_q4.onnx"])).toThrow("one coherent quantization")
})


test("chat acquisition excludes projection weights and prefers the executable quantization", () => {
    const artifacts = Artifacts()
    expect(artifacts.chat(["mmproj-F16.gguf"])).toBeNull()
    expect(artifacts.chat(["model-Q4_K_M-00001-of-00002.gguf", "mmproj-F16.gguf"])).toBeNull()
    expect(artifacts.chat(["mmproj-F16.gguf", "model-Q4_K_M.gguf", "model-Q8_0.gguf"], { "model-Q4_K_M.gguf": 105 })).toEqual({ runtime: "llama.cpp", file: "model-Q4_K_M.gguf", files: ["model-Q4_K_M.gguf"], bytes: 105 })
    expect(artifacts.chat(["model.onnx"])).toBeNull()
})

test("installing a runtime after a missing-runtime load failure can be retried", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { Runtimes, LlamaAdapter } = await import("../../src/models")
    const root = await mkdtemp(join(tmpdir(), "axon-runtime-retry-"))
    roots.push(root)
    const runtimes = Runtimes({ root: join(root, "runtimes"), run: async (_command, cwd) => {
        const packageRoot = join(cwd, "node_modules", "node-llama-cpp")
        await mkdir(packageRoot, { recursive: true })
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "node-llama-cpp", type: "module", main: "index.js" }))
        await writeFile(join(packageRoot, "index.js"), `export async function getLlama() {
            return { loadModel: async () => ({ size: 4, createContext: async () => ({ dispose: async () => {} }), dispose: async () => {} }) }
        }`)
        return { ok: true, output: "" }
    } })
    const adapter = LlamaAdapter(runtimes)
    const path = join(root, "chat.gguf")
    await writeFile(path, "GGUF")
    await expect(adapter.load(path)).rejects.toThrow()
    await runtimes.install("llama.cpp")
    const loaded = await adapter.load(path)
    expect(loaded.engine).toBe("generate")
    await loaded.unload()
})

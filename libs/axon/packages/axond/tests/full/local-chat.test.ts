import { test, expect } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { Models as Weights, ModelStore } from "@arcforge/platform/build/project"
import { LocalModels } from "../../../../../../apps/tui/platform/local-models"
import { Models, LlamaAdapter, Adapters, Catalog, Runtimes } from "../../src/models"
import { Machine } from "../../src/machine"
import { AxonDaemon } from "../../src"
import { Server, Dispatch, daemonPaths } from "../../src/control"

// Verified small fixture, cached between full runs; it is never an agent's model store.
const fixture = {
    hf: "bartowski/SmolLM2-135M-Instruct-GGUF",
    file: "SmolLM2-135M-Instruct-Q4_K_M.gguf",
    sha256: "2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d",
    capability: "chat",
    type: "generate" as const,
    in: ["text"], out: ["text"],
}

test("a real local model retains conversation context, streams, interrupts and releases memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-native-chat-"))
    const store = ModelStore({ root: join(tmpdir(), "axon-model-fixtures") })
    const weights = Weights({ store: store })
    const resolved = await weights.resolve({ chat: fixture })
    const path = resolved.paths.chat
    if (!path) throw new Error("native chat fixture did not resolve")
    const machine = Machine({ residencyRoot: join(root, "holds"), budget: () => null })
    const localStore = ModelStore({ root: join(root, "models") })
    const stored = await localStore.receive({ filename: fixture.file, body: Bun.file(path).stream(), expected: fixture.sha256 })
    const installedId = `hf:${fixture.hf}@main/${fixture.file}`
    await localStore.remember(installedId, stored, fixture.file)
    await localStore.describe(installedId, { capability: fixture.capability, type: fixture.type, in: fixture.in, out: fixture.out })
    const speech = await localStore.put("speech.onnx", new Uint8Array([1, 2, 3]))
    await localStore.remember("hf:test/whisper@main/speech.onnx", speech, "speech.onnx")
    await localStore.describe("hf:test/whisper@main/speech.onnx", { capability: "speech", type: "transform", in: ["audio"], out: ["text"] })
    const repository = { pipeline_tag: "text-generation", tags: ["gguf"], siblings: [{ rfilename: fixture.file, size: stored.bytes }] }
    const registry = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input))
        return Response.json(url.pathname === "/api/models" ? [{ modelId: fixture.hf, ...repository }] : repository)
    }, { preconnect: fetch.preconnect })
    const catalog = Catalog({ root: join(root, "catalog.json"), fetch: registry })
    const models = Models({ root: localStore.root, machine: machine, adapters: Adapters([LlamaAdapter()]), runtimes: Runtimes({ root: join(root, "runtimes") }), catalog: catalog })
    const server = Server({ paths: daemonPaths(root), dispatch: Dispatch({ domains: { models: models } }), tunnel: async () => null })
    const id = `hf:${fixture.hf}@main/${fixture.file}`
    try {
        server.listen()
        await models.refresh()
        expect((await models.local()).map(model => model.id)).toContain(id)
        const client = AxonDaemon({ root: root })
        const ui = LocalModels({ daemon: client })
        await ui.refresh()
        expect(ui.current.models.map(model => model.id)).toEqual([id])
        expect(ui.current.state?.cached).toHaveLength(2)
        await ui.search("SmolLM2")
        expect(ui.current.results.map(model => model.name)).toContain("SmolLM2-135M-Instruct-GGUF")
        await ui.detail(`hf:${fixture.hf}`)
        expect(ui.current.detail?.sizes[fixture.file]).toBe(stored.bytes)
        const download = await ui.download(`hf:${fixture.hf}`, fixture.file)
        expect(await ui.wait(download, new AbortController().signal)).toBe(id)
        await expect(ui.ready(id)).rejects.toThrow("Install this model")
        const events = []
        for await (const event of client.models.stream(id, { messages: [
            { role: "system", content: "Answer briefly." },
            { role: "user", content: "My name is Cody." },
            { role: "assistant", content: "Hello Cody." },
            { role: "user", content: "What is my name?" },
        ], maxTokens: 32, temperature: 0 })) events.push(event)
        expect(events.filter(event => event.type === "text:delta").length).toBeGreaterThan(1)
        const done = events.at(-1)
        if (done?.type !== "done") throw new Error("native model returned no response")
        expect(done.response.text.toLowerCase()).toContain("cody")
        for (const messages of [
            [{ role: "user" as const, content: "Count upwards." }, { role: "assistant" as const, content: "One, two," }],
            [{ role: "user" as const, content: "hey" }, { role: "assistant" as const, content: "hey" }, { role: "system" as const, content: "Continue briefly." }],
        ]) {
            const continued = []
            for await (const event of client.models.stream(id, { messages: messages, maxTokens: 8, temperature: 0 })) continued.push(event)
            expect(continued.some(event => event.type === "text:delta")).toBe(true)
            expect(continued.at(-1)?.type).toBe("done")
        }
        const controller = new AbortController()
        const aborted = (async () => {
            for await (const event of client.models.stream(id, { messages: [{ role: "user", content: "Count to one hundred." }], maxTokens: 128, signal: controller.signal })) {
                if (event.type === "text:delta") controller.abort()
            }
        })()
        await expect(aborted).rejects.toThrow()
        // Drain the cancelled native call before asking to unload its weight.
        const retry = client.models.stream(id, { messages: [{ role: "user", content: "Say hello." }], maxTokens: 8 })
        for await (const event of retry) { /* a subsequent call must still work */ }
        await ui.unload(id)
        expect(ui.current.state?.resident).toEqual([])
        await ui.remove(id)
        expect(ui.current.models).toEqual([])
        expect(ui.current.state?.cached).toHaveLength(1)
        expect(localStore.has(fixture.sha256, fixture.file)).toBe(false)
    } finally {
        await server.close()
        await models.dispose()
        await rm(root, { recursive: true, force: true })
    }
}, 120_000)

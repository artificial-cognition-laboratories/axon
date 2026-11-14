import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AxonBlueprint } from "../../../core/src/platform"
import { AxonCloud } from "@arcforge/cloud"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { SupervisorSideServices } from "../../src/link"

test("an unavailable unrelated provider is diagnostic data while local inference succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-local-resolution-"))
    const unavailable = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("offline", { status: 503 }) })
    const id = "hf:test/chat@main/model.gguf"
    const blueprint = AxonBlueprint({
        paths: { root: root, data: ".agent/data" },
        profileProviders: [{ provider: "ollama", url: unavailable.url.origin }],
        config: { model: `local:${id}` },
        cognet: { name: "fixture", version: "1.0.0", abi: KERNEL_ABI_VERSION, path: "/unused-resolution-only", hash: "fixture", mode: { kind: "invocation" },
            engines: { main: { type: "generate", in: ["text"], out: ["text"], structured: true, context: 100_000, primary: true } } },
    })
    const services = await SupervisorSideServices({ blueprint: blueprint,
        cloud: AxonCloud({ reporting: false, environmentCredentials: false }), sessionId: crypto.randomUUID(),
        local: {
            catalogue: async () => [{ id: id, name: "chat", provider: "local", type: "generate", in: ["text"], out: ["text"], local: true }],
            run: async () => "local answer",
            stream: async function* () { yield { type: "done", response: { text: "local answer", stopReason: "end", meta: { provider: "local", model: id, durationMs: 0 } } } },
        },
    })
    try {
        const events = []
        for await (const event of services.infer({ role: "main", request: { messages: [{ role: "user", content: "hello" }] } }, new AbortController().signal)) events.push(event)
        expect(events.at(-1)?.type).toBe("done")
        expect(services.engines.get("main").binding.capability.provider).toBe("local")
        expect(services.session.log.some(event => event.type === "axon:inference:provider:failed")).toBe(false)
        const diagnostic = services.session.log.find(event => event.type === "axon:inference:provider:complete" && event.data.provider === "ollama")
        expect(diagnostic?.data).toMatchObject({ provider: "ollama", capabilities: 0, failure: { message: "ollama: /api/tags answered 503" } })
        expect(services.session.log.some(event => event.type === "axon:error")).toBe(false)
    } finally {
        await services.close()
        await unavailable.stop(true)
        await rm(root, { recursive: true, force: true })
    }
})

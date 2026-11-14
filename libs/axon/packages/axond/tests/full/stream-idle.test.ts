import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Server, daemonPaths } from "../../src/control"
import { AxonDaemon } from "../../src"

test("inference can wait longer than the HTTP idle timeout for its first token", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-stream-idle-"))
    const server = Server({ paths: daemonPaths(root), dispatch: async () => (async function* () {
        await Bun.sleep(21_000)
        yield { type: "text:delta", content: "hello" }
        yield { type: "done", response: { text: "hello", stopReason: "end", meta: { provider: "local", model: "test", durationMs: 21_000 } } }
    })(), tunnel: async () => null })
    try {
        server.listen()
        const events = []
        for await (const event of AxonDaemon({ root: root }).models.stream("test", { messages: [{ role: "user", content: "hi" }] })) events.push(event)
        expect(events.map(event => event.type)).toEqual(["text:delta", "done"])
    } finally {
        await server.close()
        await rm(root, { recursive: true, force: true })
    }
}, 30_000)

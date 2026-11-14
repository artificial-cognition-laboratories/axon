import { test, expect, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Conversation, Generation } from "../../src/models/generation"
import { Execution } from "../../src/models/execution"
import { Server, Dispatch, daemonPaths } from "../../src/control"
import { AxonDaemon } from "../../src"
import type { AxonEngineRawEvent, AxonEngineRequest } from "@arcforge/types"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

test("conversation keeps system instructions and previous assistant replies", () => {
    const conversation = Conversation({ messages: [
        { role: "system", content: "Remember the user's name" },
        { role: "user", content: "My name is Cody" },
        { role: "assistant", content: "Hello Cody" },
        { role: "user", content: [{ type: "text", text: "What is my name?" }] },
    ] }).llama()
    expect(conversation).toEqual([
        { type: "system", text: "Remember the user's name" },
        { type: "user", text: "My name is Cody" },
        { type: "model", response: ["Hello Cody"] },
        { type: "user", text: "What is my name?" },
        { type: "model", response: [] },
    ])
})

test("local inference accepts harness continuation after an assistant reply", () => {
    expect(Conversation({ messages: [
        { role: "user", content: "hey" },
        { role: "assistant", content: "hey" },
    ] }).llama()).toEqual([
        { type: "user", text: "hey" },
        { type: "model", response: ["hey"] },
        { type: "model", response: [] },
    ])
})

test("a local stream crosses the socket before inference completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-local-stream-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const request: AxonEngineRequest = { messages: [{ role: "user", content: "hello" }] }
    const execution = Execution({ acquire: async () => ({
        bytes: 1, engine: "generate", run: async () => "", unload: async () => {},
        chat: input => Generation({ model: "test", request: input, run: async onText => {
            onText("first")
            await pending
            onText(" second")
            return "length"
        } }).stream(),
    }) })
    const server = Server({ paths: daemonPaths(root), dispatch: Dispatch({ domains: { models: { stream: execution.stream } } }), tunnel: async () => null })
    server.listen()
    cleanup.push(server.close)
    const stream = AxonDaemon({ root: root }).models.stream("hf:test/model", request)
    expect((await stream.next()).value).toEqual({ type: "text:delta", content: "first" })
    expect(() => execution.assertIdle("hf:test/model")).toThrow("queued or active inference")
    finish()
    const events: AxonEngineRawEvent[] = []
    for await (const event of stream) events.push(event)
    expect(events[0]).toEqual({ type: "text:delta", content: " second" })
    const done = events[1]
    expect(done?.type).toBe("done")
    if (done?.type !== "done") throw new Error("expected final response")
    expect(done.response.text).toBe("first second")
    expect(done.response.stopReason).toBe("length")
    expect(done.response.meta.model).toBe("hf:test/model")
    expect(() => execution.assertIdle("hf:test/model")).not.toThrow()
})

test("leaving a streamed inference aborts the runtime and releases its lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-local-abort-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    let aborted!: () => void
    const stopped = new Promise<void>(resolve => { aborted = resolve })
    const execution = Execution({ acquire: async () => ({
        bytes: 1, engine: "generate", run: async () => "", unload: async () => {},
        chat: input => Generation({ model: "test", request: input, run: async (onText, signal) => {
            onText("first")
            await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted(); resolve() }, { once: true }))
            return "end"
        } }).stream(),
    }) })
    const server = Server({ paths: daemonPaths(root), dispatch: Dispatch({ domains: { models: { stream: execution.stream } } }), tunnel: async () => null })
    server.listen()
    cleanup.push(server.close)
    const stream = AxonDaemon({ root: root }).models.stream("hf:test/model", { messages: [{ role: "user", content: "hi" }] })
    await stream.next()
    await stream.return(undefined)
    await Promise.race([stopped, Bun.sleep(500).then(() => { throw new Error("runtime did not abort") })])
    await Bun.sleep(20)
    expect(() => execution.assertIdle("hf:test/model")).not.toThrow()
})

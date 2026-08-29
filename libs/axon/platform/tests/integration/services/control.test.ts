import { describe, expect, test } from "bun:test"
import type { AxonInstance } from "@arcforge/types"
import { ControlClient } from "../../../src/services/control/client"
import { ControlServer } from "../../../src/services/control/server"

/**
 * The control channel, driven end to end through both public handles.
 *
 * Every test here boots a real ControlServer on a real ephemeral port and
 * dials it with a real ControlClient — no fake transport, no reaching into
 * Dispatch. What is asserted is what a caller can observe: the value a call
 * returns, the error it throws, and whether the peer's handle actually ran.
 */

/** A stand-in instance record — the only field the client reads is `control`. */
function instanceOf(server: ReturnType<typeof ControlServer>): AxonInstance {
    return {
        pid: process.pid,
        sessionId: "test-session",
        agentName: "@test/agent",
        projectRoot: "/tmp/test",
        dataRoot: "/tmp/test/data",
        startedAt: new Date().toISOString(),
        control: { port: server.port!, token: server.token },
    }
}

describe("control channel", () => {
    test("editor calls the tui and receives its return value", async () => {
        const sent: string[] = []
        const server = ControlServer({
            handle: { tui: { send: async (content: string) => { sent.push(content); return `ack:${content}` } } },
        })
        server.listen()

        const client = ControlClient({ handle: {} })
        await client.connect(instanceOf(server))

        const result = await client.tui.call("send", "hello agent")

        expect(sent).toEqual(["hello agent"])
        expect(result).toBe("ack:hello agent")

        client.disconnect()
        server.close()
    })

    test("tui calls the editor — the same channel, opposite direction", async () => {
        const focused: unknown[] = []
        const server = ControlServer({ handle: {} })
        server.listen()

        const client = ControlClient({
            handle: { editor: { focus: async (target: unknown) => { focused.push(target); } } },
        })
        await client.connect(instanceOf(server))

        await server.editor.call("focus", { sessionId: "abc", tab: "events" })

        expect(focused).toEqual([{ sessionId: "abc", tab: "events" }])

        client.disconnect()
        server.close()
    })

    test("a throw on the peer rejects at the call site rather than returning undefined", async () => {
        const server = ControlServer({
            handle: { tui: { send: async () => { throw new Error("agent is busy") } } },
        })
        server.listen()

        const client = ControlClient({ handle: {} })
        await client.connect(instanceOf(server))

        expect(client.tui.call("send", "x")).rejects.toThrow(/agent is busy/)

        client.disconnect()
        server.close()
    })

    test("calling a method the peer does not expose rejects", async () => {
        const server = ControlServer({ handle: { tui: {} } })
        server.listen()

        const client = ControlClient({ handle: {} })
        await client.connect(instanceOf(server))

        expect(client.tui.call("send", "x")).rejects.toThrow(/tui\.send/)

        client.disconnect()
        server.close()
    })

    test("a wrong token is rejected at the handshake, before any call is served", async () => {
        let served = false
        const server = ControlServer({ handle: { tui: { send: async () => { served = true } } } })
        server.listen()

        const client = ControlClient({ handle: {} })
        const record = instanceOf(server)

        expect(
            client.connect({ ...record, control: { port: record.control!.port, token: "wrong-token" } }),
        ).rejects.toThrow()

        expect(served).toBe(false)
        server.close()
    })

    test("calling with no peer attached rejects instead of silently doing nothing", async () => {
        const server = ControlServer({ handle: {} })
        server.listen()

        expect(server.editor.call("focus", {})).rejects.toThrow(/no editor attached/)

        server.close()
    })

    test("an in-flight call rejects when the tui goes away", async () => {
        // A call the peer never answers — the socket dying is the only
        // thing that can settle it. This is the hang that would otherwise
        // leave the editor waiting forever on a dead TUI.
        const server = ControlServer({ handle: { tui: { send: () => new Promise(() => {}) } } })
        server.listen()

        const client = ControlClient({ handle: {} })
        await client.connect(instanceOf(server))

        const pending = client.tui.call("send", "never answered")
        server.close()

        expect(pending).rejects.toThrow()

        client.disconnect()
    })

    test("watch reports attach and detach as they happen", async () => {
        // What a UI gates on: a button that opens something in the editor must
        // not render when no editor is reachable. Polling peerCount would need
        // a timer and would still miss transitions the socket already knows
        // about exactly — so membership is announced, not sampled.
        const server = ControlServer({ handle: {} })
        server.listen()

        const counts: number[] = []
        const unwatch = server.watch(count => counts.push(count))

        const client = ControlClient({ handle: {} })
        await client.connect(instanceOf(server))
        expect(counts).toEqual([1])
        expect(server.attached).toBe(true)

        client.disconnect()
        // The close handler is what removes a peer, so wait for the socket
        // rather than asserting synchronously on a disconnect we just asked for.
        await Bun.sleep(50)

        expect(counts).toEqual([1, 0])
        expect(server.attached).toBe(false)

        unwatch()
        server.close()
    })

    test("a stopped watcher stops hearing about membership", async () => {
        const server = ControlServer({ handle: {} })
        server.listen()

        const counts: number[] = []
        server.watch(count => counts.push(count))()

        const client = ControlClient({ handle: {} })
        await client.connect(instanceOf(server))

        expect(counts).toEqual([])

        client.disconnect()
        server.close()
    })

    // Subscriptions (rpc.subscribe/event/unsubscribe) are implemented in
    // Dispatch and carried by both transports, but neither ControlServer
    // nor ControlClient exposes a public `subscribe()` yet — v1 has no
    // streaming consumer. They get a test when they get a surface; testing
    // them now would mean reaching through the handles into Dispatch,
    // which is exactly the implementation-coupling this suite avoids.
})

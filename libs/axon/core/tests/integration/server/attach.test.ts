import { Agents, RemoteAgent } from "@arclabs/cloud"
import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

/**
 * End-to-end transport-transparency: a real Axon() runtime served on a real
 * port, reached through the AxonCloud RemoteAgent handle. Proves that
 * attach()'s request/stream behave identically to the local axon handle — the
 * whole point of the consumer-subset mirror. No mocks on the wire: a genuine
 * HTTP server, a genuine fetch client.
 */
describe("attach → deployed agent (local)", () => {
    async function serve(runtime: Awaited<ReturnType<typeof Axon>>) {
        const server = Bun.serve({ port: 0, fetch: req => runtime.server.handler(req) })
        const url = `http://localhost:${server.port}`
        return { url, stop: () => server.stop(true) }
    }

    it("attach handshake resolves the instance's session id", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock() } } })
        const { url, stop } = await serve(runtime)

        try {
            const { axon, sessionId } = await Agents().attach(url)
            expect(sessionId).toBe(runtime.session.id)
            expect(axon.session.id).toBe(runtime.session.id)
        } finally {
            stop()
            await runtime.shutdown()
        }
    })

    it("remote request() returns the same AxonResult a local request would", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "Hi there!" }) } } })
        const { url, stop } = await serve(runtime)

        try {
            const { axon } = await Agents().attach(url)
            const result = await axon.request("hello")
            expect(result.text).toBe("Hi there!")
            expect(Array.isArray(result.entries)).toBe(true)
        } finally {
            stop()
            await runtime.shutdown()
        }
    })

    it("remote stream() yields entries and completes cleanly", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "Hi there!" }) } } })
        const { url, stop } = await serve(runtime)

        try {
            const { axon } = await Agents().attach(url)
            const entries = []
            for await (const entry of axon.stream("hello").stream) {
                entries.push(entry)
            }
            // At least the text output entry made it across the wire.
            expect(entries.some(e => e.type === "cognet:output:text")).toBe(true)
        } finally {
            stop()
            await runtime.shutdown()
        }
    })

    it("a bare string and a { prompt } object behave identically over the wire", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "Hi there!" }) } } })
        const { url, stop } = await serve(runtime)

        try {
            const agent = RemoteAgent({ url, sessionId: runtime.session.id })
            const a = await agent.request("hello")
            const b = await agent.request({ prompt: "hello" })
            expect(a.text).toBe("Hi there!")
            expect(b.text).toBe("Hi there!")
        } finally {
            stop()
            await runtime.shutdown()
        }
    })

    // ── Connect gate (enforcing, end to end) ─────────────────────────────────
})

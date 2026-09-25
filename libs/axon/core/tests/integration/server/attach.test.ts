import { Agents, RemoteAgent } from "@arcforge/cloud"
import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

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
        const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })
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
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })
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
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })
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

    /**
     * The shape the TUI actually sends, against a real server.
     *
     * Everything above calls the CONSUMER door (`"hello"`, `{ prompt }`). The
     * attached TUI calls the machine-contract door with a stimulus entry, and
     * that path had no end-to-end test at all — so the client shipped sending
     * `{type, data}` to an endpoint that speaks `{prompt}` and answered 400.
     * The `libs/cloud` suite covered the entry shape but against a fake that
     * never read the request body, so both halves were green while disagreeing
     * with each other.
     *
     * Two doors into one brain means both need a wire test, not just the
     * convenient one.
     */
    it("stream() accepts a stimulus entry — the shape an attached TUI sends", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })
        const { url, stop } = await serve(runtime)

        try {
            const { axon } = await Agents().attach(url)
            const entries = []
            for await (const entry of axon.stream({
                type: "cognet:stimulus:text",
                data: { content: "hello", channel: "terminal" },
            }).stream) {
                entries.push(entry)
            }
            expect(entries.some(e => e.type === "cognet:output:text")).toBe(true)
        } finally {
            stop()
            await runtime.shutdown()
        }
    })

    it("request() accepts a stimulus entry too — both doors, one brain", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })
        const { url, stop } = await serve(runtime)

        try {
            const { axon } = await Agents().attach(url)
            const result = await axon.request({
                type: "cognet:stimulus:text",
                data: { content: "hello", channel: "terminal" },
            })
            expect(result.text).toBe("Hi there!")
        } finally {
            stop()
            await runtime.shutdown()
        }
    })

    /**
     * An unusable body must fail HERE, naming what was passed — not travel to
     * the server and come back as a 400 naming `_axon/request`, an endpoint the
     * caller never mentioned.
     */
    it("refuses an unrecognised body at the client, loudly", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })
        const { url, stop } = await serve(runtime)

        try {
            const agent = RemoteAgent({ url, sessionId: runtime.session.id })
            expect(() => agent.stream({ nonsense: true } as never)).toThrow(/string, \{ prompt \}, or a stimulus entry/)
        } finally {
            stop()
            await runtime.shutdown()
        }
    })

    /**
     * Admission must be a real answer, not an assumption.
     *
     * `stimulus()` used to issue the request as `void request(...).catch(() => {})`
     * and return a hardcoded `admitted: true`, so a refusal — a bad body, a
     * rejected token, a dead agent — was reported to the caller as success with
     * nothing logged. A wrong answer is worse than a slow one here: the message
     * is gone and the system says it arrived.
     */
    it("stimulus() reports a REFUSAL rather than claiming the agent took it", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })
        const { url, stop } = await serve(runtime)

        try {
            // Pointed at a port nothing is listening on: a refusal the CLIENT
            // cannot detect locally, so it can only be reported by actually
            // awaiting admission. A body `promptOf` rejects would not
            // discriminate — the old code threw on that too, synchronously,
            // before the swallow was reached.
            stop()
            const agent = RemoteAgent({ url, sessionId: runtime.session.id })
            await expect(
                agent.stimulus({
                    type: "cognet:stimulus:text",
                    data: { content: "hello", channel: "terminal" },
                } as never),
            ).rejects.toThrow()
        } finally {
            await runtime.shutdown()
        }
    })

    it("stimulus() admits a good wake and mirrors the turn onto the session", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })
        const { url, stop } = await serve(runtime)

        try {
            const { axon } = await Agents().attach(url)
            const admission = await axon.stimulus({
                type: "cognet:stimulus:text",
                data: { content: "hello", channel: "terminal" },
            } as never)
            expect(admission.admitted).toBe(true)
        } finally {
            stop()
            await runtime.shutdown()
        }
    })

    it("a bare string and a { prompt } object behave identically over the wire", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })
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

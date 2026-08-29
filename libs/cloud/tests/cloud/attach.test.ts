import { describe, expect, it } from "bun:test"
import type { AxonEntry, AxonSessionSnapshot } from "@arcforge/types"
import { Agents } from "../../src/cloud/agents/agents"

/**
 * attach() + the mirrored session — the contract that makes a deployed agent
 * render identically to a local one.
 *
 * fetch is injected so these are exact rather than timing-dependent: the whole
 * point under test is the hydrate/stream ordering guarantee, and that is only
 * provable if the test controls precisely what each call returns and in what
 * order. Nothing here reaches into internals — everything goes through the
 * handle attach() resolves.
 */

/**
 * A minimal AxonEntry. The `type` must be a REAL entry family: the mirror routes
 * by classifyEvent(), so an invented type would file into `log` and the test
 * would assert against the wrong array.
 */
function entry(seq: number, text: string): AxonEntry {
    return {
        id: `e${seq}`,
        type: "cognet:output:text",
        time: { ms: 1_700_000_000_000 + seq, seq },
        context: {},
        data: { role: "assistant", content: text },
    } as unknown as AxonEntry
}

function snapshot(partial: Partial<AxonSessionSnapshot> = {}): AxonSessionSnapshot {
    return {
        id: "session-1",
        entries: [],
        log: [],
        kernelLog: [],
        cursor: 0,
        truncated: false,
        ...partial,
    }
}

function sse(entries: AxonEntry[]): Response {
    const body = entries.map(item => `data: ${JSON.stringify(item)}\n\n`).join("") + "event: done\ndata: {}\n\n"
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

/**
 * A fake agent. Records the URLs it was called with so a test can assert what
 * the client asked for, and serves whatever the test queued.
 */
function agent(routes: {
    health?: { sessionId: string }
    session?: AxonSessionSnapshot | ((url: URL) => AxonSessionSnapshot)
    stream?: AxonEntry[]
    /** Frames served by GET /_axon/events, in order. `null` marks the live boundary. */
    events?: (AxonEntry | null)[] | ((url: URL) => (AxonEntry | null)[])
    /** Force GET /_axon/events to fail with this status. */
    eventsStatus?: number
}) {
    const calls: string[] = []

    const doFetch = (async (input: string | URL) => {
        const url = new URL(typeof input === "string" ? input : input.toString())
        calls.push(`${url.pathname}${url.search}`)

        if (url.pathname === "/_axon/health") {
            return Response.json({ ok: true, ...(routes.health ?? { sessionId: "session-1" }) })
        }
        if (url.pathname === "/_axon/session") {
            const resolved = typeof routes.session === "function" ? routes.session(url) : routes.session
            return Response.json(resolved ?? snapshot())
        }
        if (url.pathname === "/_axon/stream") {
            return sse(routes.stream ?? [])
        }
        if (url.pathname === "/_axon/events") {
            if (routes.eventsStatus !== undefined) {
                return new Response("nope", { status: routes.eventsStatus })
            }
            const frames = typeof routes.events === "function" ? routes.events(url) : (routes.events ?? [])
            const body = frames
                .map(frame =>
                    frame === null
                        ? `event: live\ndata: ${JSON.stringify({ cursor: null })}\n\n`
                        : `id: ${frame.time.seq}\ndata: ${JSON.stringify(frame)}\n\n`,
                )
                .join("")
            return new Response(body, { headers: { "content-type": "text/event-stream" } })
        }
        return new Response("not found", { status: 404 })
    }) as unknown as typeof fetch

    return { fetch: doFetch, calls }
}

/** A non-entry event, to prove classification routes into the right log. */
function kernelEvent(seq: number): AxonEntry {
    return {
        id: `k${seq}`,
        type: "kernel:tick",
        time: { ms: 1_700_000_000_000 + seq, seq },
        context: {},
        data: {},
    } as unknown as AxonEntry
}

/** Resolves once the subscription reports live. */
function waitForLive(axon: { session: { subscribe: (h: Record<string, unknown>) => () => void } }) {
    return new Promise<() => void>(resolve => {
        const unsubscribe = axon.session.subscribe({
            onLive: () => resolve(unsubscribe),
            onClose: () => resolve(unsubscribe),
        })
    })
}

/** A text stimulus — the canonical way into a brain. A prompt is this entry. */
function text(content: string) {
    return { type: "cognet:stimulus:text", data: { channel: "terminal", content: content } } as never
}

describe("attach", () => {
    it("hydrates the session so history is present the moment attach resolves", async () => {
        const fake = agent({
            session: snapshot({ entries: [entry(1, "one"), entry(2, "two")], cursor: 2 }),
        })

        const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")

        // The consumer never sees an empty mirror that fills later.
        expect(axon.session.entries.map(e => (e.data as { content: string }).content)).toEqual(["one", "two"])
        expect(axon.session.cursor).toBe(2)
        expect(axon.session.id).toBe("session-1")
    })

    it("mirrors the seq-0 event — the session's own opening event", async () => {
        // Regression: cursor started at 0 with a `seq > cursor` filter, so
        // axon:session:opened (always seq 0) was silently dropped on every
        // attach. "Nothing mirrored yet" must stay distinct from "at seq 0".
        const fake = agent({
            session: snapshot({ entries: [entry(0, "first"), entry(1, "second")], cursor: 1 }),
        })

        const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")

        expect(axon.session.entries.map(e => e.time.seq)).toEqual([0, 1])
    })

    it("a hydrate at cursor 0 asks for events strictly after 0", async () => {
        const fake = agent({
            session: url =>
                url.searchParams.get("since") === "0"
                    ? snapshot({ entries: [entry(1, "next")], cursor: 1 })
                    : snapshot({ entries: [entry(0, "zero")], cursor: 0 }),
        })

        const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
        expect(axon.session.cursor).toBe(0)

        await axon.session.hydrate()

        // since=0 is a real cursor, not "unset" — the zero event is not refetched.
        expect(fake.calls).toContain("/_axon/session?since=0")
        expect(axon.session.entries.map(e => e.time.seq)).toEqual([0, 1])
    })

    it("mirrors streamed entries onto the session as they pass through", async () => {
        const fake = agent({
            session: snapshot({ entries: [entry(1, "history")], cursor: 1 }),
            stream: [entry(2, "live")],
        })

        const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
        for await (const _ of axon.stream(text("hi")).stream) { /* drain */ }

        expect(axon.session.entries.map(e => (e.data as { content: string }).content)).toEqual(["history", "live"])
        expect(axon.session.cursor).toBe(2)
    })

    it("drops a streamed entry already covered by the hydrate", async () => {
        // The race this closes: an entry present in the snapshot AND replayed on
        // the stream must land exactly once.
        const duplicated = entry(2, "two")
        const fake = agent({
            session: snapshot({ entries: [entry(1, "one"), duplicated], cursor: 2 }),
            stream: [duplicated, entry(3, "three")],
        })

        const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
        for await (const _ of axon.stream(text("hi")).stream) { /* drain */ }

        expect(axon.session.entries.map(e => (e.data as { content: string }).content)).toEqual(["one", "two", "three"])
    })

    it("a reconnect hydrate asks only for the gap after the cursor", async () => {
        const fake = agent({
            session: url =>
                url.searchParams.get("since") === "2"
                    ? snapshot({ entries: [entry(3, "gap")], cursor: 3 })
                    : snapshot({ entries: [entry(1, "one"), entry(2, "two")], cursor: 2 }),
        })

        const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
        await axon.session.hydrate()

        // Second hydrate passed the cursor, so the whole history was not refetched.
        expect(fake.calls).toContain("/_axon/session?since=2")
        expect(axon.session.entries.map(e => (e.data as { content: string }).content)).toEqual(["one", "two", "gap"])
        expect(axon.session.cursor).toBe(3)
    })

    it("hydrate: false skips the session fetch entirely", async () => {
        const fake = agent({ session: snapshot({ entries: [entry(1, "one")], cursor: 1 }) })

        const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent", { hydrate: false })

        expect(fake.calls.some(call => call.startsWith("/_axon/session"))).toBe(false)
        expect(axon.session.entries).toEqual([])
    })

    it("forwards a session query so a caller can omit the kernel firehose", async () => {
        const fake = agent({ session: snapshot() })

        await Agents({ fetch: fake.fetch }).attach("http://agent", {
            session: { include: ["entries", "log"] },
        })

        expect(fake.calls).toContain("/_axon/session?include=entries%2Clog")
    })

    describe("subscribe", () => {
        it("routes streamed events into the log they belong to", async () => {
            const fake = agent({
                session: snapshot(),
                events: [entry(1, "hello"), kernelEvent(2), null],
            })

            const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
            const unsubscribe = await waitForLive(axon)

            // Classification comes from @arcforge/types — the same rule core uses.
            expect(axon.session.entries.map(e => e.time.seq)).toEqual([1])
            expect(axon.session.kernelLog.map(e => e.time.seq)).toEqual([2])
            unsubscribe()
        })

        it("resumes from the cursor so a reconnect only asks for the gap", async () => {
            const fake = agent({
                session: snapshot({ entries: [entry(1, "one")], cursor: 1 }),
                events: [null],
            })

            const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
            const unsubscribe = await waitForLive(axon)

            expect(fake.calls).toContain("/_axon/events?since=1")
            unsubscribe()
        })

        it("does not re-absorb an event the hydrate already covered", async () => {
            const replayed = entry(1, "one")
            const fake = agent({
                session: snapshot({ entries: [replayed], cursor: 1 }),
                // The server replays from the cursor; a boundary overlap must not duplicate.
                events: [replayed, entry(2, "two"), null],
            })

            const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
            const unsubscribe = await waitForLive(axon)

            expect(axon.session.entries.map(e => (e.data as { content: string }).content)).toEqual(["one", "two"])
            unsubscribe()
        })

        it("fires onEvent only for events that actually landed", async () => {
            const replayed = entry(1, "one")
            const fake = agent({
                session: snapshot({ entries: [replayed], cursor: 1 }),
                events: [replayed, entry(2, "two"), null],
            })

            const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
            const seen: number[] = []
            await new Promise<void>(resolve => {
                const stop = axon.session.subscribe({
                    onEvent: event => { seen.push(event.time.seq) },
                    onLive: () => { stop(); resolve() },
                })
            })

            // The duplicate is dropped, so a reactive consumer does not re-render for it.
            expect(seen).toEqual([2])
        })

        it("surfaces a broken stream through onError rather than swallowing it", async () => {
            const fake = agent({ session: snapshot(), eventsStatus: 500 })

            const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
            const error = await new Promise<Error>(resolve => {
                axon.session.subscribe({ onError: resolve })
            })

            // A silently dead stream is indistinguishable from an idle agent.
            expect(error.message).toContain("_axon/events failed: 500")
        })

        it("include= asks the server to filter server-side", async () => {
            const fake = agent({ session: snapshot(), events: [null] })

            const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
            const unsubscribe = await new Promise<() => void>(resolve => {
                const stop = axon.session.subscribe({
                    include: ["entries"],
                    onLive: () => resolve(stop),
                })
            })

            expect(fake.calls.some(call => call.includes("/_axon/events") && call.includes("include=entries"))).toBe(true)
            unsubscribe()
        })

        it("unsubscribe stops delivery without reporting an error", async () => {
            const fake = agent({ session: snapshot(), events: [entry(1, "one"), null] })

            const { axon } = await Agents({ fetch: fake.fetch }).attach("http://agent")
            let errored: Error | null = null
            const unsubscribe = axon.session.subscribe({ onError: e => { errored = e } })
            unsubscribe()

            // Aborting is a normal teardown, not a failure.
            await new Promise(resolve => setTimeout(resolve, 20))
            expect(errored).toBeNull()
        })
    })

    it("fails loudly when the agent is unreachable", async () => {
        const doFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch

        await expect(Agents({ fetch: doFetch }).attach("http://agent")).rejects.toThrow(/unreachable/)
    })

    it("fails loudly when the session endpoint errors rather than mirroring nothing", async () => {
        const doFetch = (async (input: string | URL) => {
            const url = new URL(typeof input === "string" ? input : input.toString())
            if (url.pathname === "/_axon/health") return Response.json({ ok: true, sessionId: "s" })
            return new Response("boom", { status: 500 })
        }) as unknown as typeof fetch

        // A silently empty mirror would look like an agent with no history.
        await expect(Agents({ fetch: doFetch }).attach("http://agent")).rejects.toThrow(/_axon\/session failed: 500/)
    })
})

/**
 * The agent's own name, carried on the health handshake.
 *
 * A caller attaching to a bare URL has no other source for it — a deployment
 * knows its name from the control plane's record, but `:attach
 * http://localhost:3010` knows only an address. Without this the TUI renders a
 * hostname in the slot where an agent identity belongs.
 */
describe("attach: the agent's identity", () => {
    it("resolves the name from the handshake", async () => {
        const fake = agent({ health: { sessionId: "session-1", agent: "@axon/zeno" } as never })
        const agents = Agents({ fetch: fake.fetch })

        const result = await agents.attach("http://localhost:3010", { hydrate: false })

        expect(result.agent).toBe("@axon/zeno")
    })

    it("reports an empty name rather than failing when health omits it", async () => {
        // An agent published before health carried a name still attaches — the
        // caller falls back to the address. A hard requirement here would make
        // a new client unable to talk to an older agent.
        const fake = agent({ health: { sessionId: "session-1" } })
        const agents = Agents({ fetch: fake.fetch })

        const result = await agents.attach("http://localhost:3010", { hydrate: false })

        expect(result.agent).toBe("")
        expect(result.sessionId).toBe("session-1")
    })

    it("attaches to a local dev server with no token", async () => {
        // The connect gate is open locally, so no authorization header is
        // minted or sent. This is what makes `:attach http://localhost:3010`
        // work without a login.
        const fake = agent({ health: { sessionId: "dev-1", agent: "@axon/zeno" } as never })
        const agents = Agents({ fetch: fake.fetch })

        const result = await agents.attach("http://localhost:3010", { hydrate: false })

        expect(result.sessionId).toBe("dev-1")
        expect(fake.calls[0]).toBe("/_axon/health")
    })
})

/**
 * What the agent reports it is carrying.
 *
 * A client that attached over the wire never built this agent and has no
 * blueprint to read, so the counts have to come from the agent itself. The
 * header would otherwise spin forever where "5 mods, 4 tools" belongs.
 */
describe("attach: what the agent is carrying", () => {
    it("resolves the module and tool counts from the handshake", async () => {
        const fake = agent({ health: { sessionId: "s1", agent: "@axon/zeno", modules: 5, tools: 4 } as never })
        const agents = Agents({ fetch: fake.fetch })

        const result = await agents.attach("http://localhost:3010", { hydrate: false })

        expect(result.loaded).toEqual({ modules: 5, tools: 4 })
    })

    it("reports zero counts as zero, not as absent", async () => {
        // An agent with no modules is a real and common state. Folding it into
        // null would render a blank row that reads as a failed load.
        const fake = agent({ health: { sessionId: "s1", agent: "@axon/bare", modules: 0, tools: 0 } as never })
        const agents = Agents({ fetch: fake.fetch })

        const result = await agents.attach("http://localhost:3010", { hydrate: false })

        expect(result.loaded).toEqual({ modules: 0, tools: 0 })
    })

    it("reports null when the agent did not say", async () => {
        // An older agent, whose health predates the counts. Distinct from
        // zero — the header shows nothing rather than claiming an empty agent.
        const fake = agent({ health: { sessionId: "s1", agent: "@axon/old" } as never })
        const agents = Agents({ fetch: fake.fetch })

        const result = await agents.attach("http://localhost:3010", { hydrate: false })

        expect(result.loaded).toBeNull()
    })
})

/**
 * Heartbeat comments must be invisible.
 *
 * The server sends `: keepalive` on an idle event stream so Bun's idleTimeout
 * does not cut a healthy connection — which the client cannot distinguish from
 * the agent dying, and answers by reconnecting, idling, and being cut off
 * again every ten seconds forever.
 *
 * That fix is only safe if the parser ignores the comment. Pinned here rather
 * than assumed, because a heartbeat that parsed as an event would inject
 * garbage into the caller's session on a five-second interval.
 */
describe("attach: the event stream's heartbeat", () => {
    it("ignores SSE comment frames between real events", async () => {
        const seen: string[] = []
        const doFetch = (async (input: string | URL) => {
            const url = new URL(typeof input === "string" ? input : input.toString())
            if (url.pathname === "/_axon/health") return Response.json({ ok: true, sessionId: "s1" })
            if (url.pathname === "/_axon/session") return Response.json(snapshot())
            if (url.pathname === "/_axon/events") {
                const body = [
                    ": keepalive\n\n",
                    `data: ${JSON.stringify(entry(1, "hello"))}\n\n`,
                    ": keepalive\n\n",
                    `data: ${JSON.stringify(entry(2, "world"))}\n\n`,
                ].join("")
                return new Response(body, { headers: { "content-type": "text/event-stream" } })
            }
            return new Response("not found", { status: 404 })
        }) as unknown as typeof fetch

        const agents = Agents({ fetch: doFetch })
        const { axon } = await agents.attach("http://localhost:3010", { hydrate: false })

        await new Promise<void>(resolve => {
            axon.session.subscribe({
                onEvent: event => { seen.push((event as unknown as { id: string }).id) },
                onClose: () => resolve(),
                onError: () => resolve(),
            })
        })

        // Exactly the two real events — no phantom frame from either comment.
        expect(seen).toEqual(["e1", "e2"])
    })
})

/**
 * Reconnecting to an agent that RESTARTED.
 *
 * A dev server rebooting on a file save is a new session, and `seq` restarts
 * at 0 with it. That makes the old cursor actively harmful rather than merely
 * stale: resuming with `?since=47` against a session whose events are seq
 * 0..12 filters out every one of them, server-side and again client-side. The
 * stream connects, reports healthy, and delivers nothing — the user sends a
 * message and watches it vanish into a transcript frozen at the restart.
 */
describe("attach: the agent restarted under us", () => {
    /** An agent whose session id (and event seqs) change on demand. */
    function restartable() {
        let current = { sessionId: "session-1", events: [entry(40, "old")] }
        const calls: string[] = []

        const doFetch = (async (input: string | URL) => {
            const url = new URL(typeof input === "string" ? input : input.toString())
            calls.push(`${url.pathname}${url.search}`)

            if (url.pathname === "/_axon/health") {
                return Response.json({ ok: true, sessionId: current.sessionId })
            }
            if (url.pathname === "/_axon/events") {
                const since = url.searchParams.get("since")
                // The server filters by seq, exactly as eventStream does.
                const mark = since === null ? -1 : Number(since)
                const body = current.events
                    .filter(e => e.time.seq > mark)
                    .map(e => `data: ${JSON.stringify(e)}\n\n`)
                    .join("")
                return new Response(body, { headers: { "content-type": "text/event-stream" } })
            }
            return new Response("not found", { status: 404 })
        }) as unknown as typeof fetch

        return {
            fetch: doFetch,
            calls,
            restart(): void {
                // New session, seqs from zero — below the old cursor.
                current = { sessionId: "session-2", events: [entry(0, "fresh"), entry(1, "hey")] }
            },
        }
    }

    it("drops the dead session's history and mirrors the new one", async () => {
        const fake = restartable()
        const agents = Agents({ fetch: fake.fetch })
        const { axon } = await agents.attach("http://localhost:3010", { hydrate: false })

        await new Promise<void>(r => {
            axon.session.subscribe({ onClose: () => r(), onError: () => r() })
        })
        expect(axon.session.entries.length).toBe(1)

        fake.restart()

        let reset = ""
        await new Promise<void>(r => {
            axon.session.subscribe({
                onReset: id => { reset = id },
                onClose: () => r(),
                onError: () => r(),
            })
        })

        // The consumer was told, so it can re-read rather than append.
        expect(reset).toBe("session-2")
        // And the new session's events actually arrived — the whole point.
        expect(axon.session.entries.map(e => (e.data as { content: string }).content)).toEqual(["fresh", "hey"])
        expect(axon.session.id).toBe("session-2")
    })

    it("does not reset when the same agent is still there", async () => {
        // The common case: a wire dropped by an idle timeout, same session
        // behind it. Discarding history here would lose a live conversation.
        const fake = restartable()
        const agents = Agents({ fetch: fake.fetch })
        const { axon } = await agents.attach("http://localhost:3010", { hydrate: false })

        await new Promise<void>(r => { axon.session.subscribe({ onClose: () => r(), onError: () => r() }) })

        let reset = false
        await new Promise<void>(r => {
            axon.session.subscribe({ onReset: () => { reset = true }, onClose: () => r(), onError: () => r() })
        })

        expect(reset).toBe(false)
        expect(axon.session.entries.length).toBe(1)
    })
})

/**
 * The engine an attached agent declares.
 *
 * A client that attached over the wire has no blueprint, so the model row is
 * empty unless the agent reports its own engine. Flattened agent-side, because
 * an EngineRef and a constructed AxonEngineDef are the same fact written two
 * ways — collapsing them here would make the row's meaning depend on which
 * form the author's config happened to use.
 */
describe("attach: the engine the agent declares", () => {
    it("resolves provider and model from the handshake", async () => {
        const fake = agent({
            health: { sessionId: "s1", engine: { provider: "codex", model: "gpt-5.6-terra" } } as never,
        })
        const agents = Agents({ fetch: fake.fetch })

        const result = await agents.attach("http://localhost:3010", { hydrate: false })

        expect(result.engine).toEqual({ provider: "codex", model: "gpt-5.6-terra" })
    })

    it("carries a null model without losing the provider", async () => {
        // `{ provider: "mock" }` is a real declaration with no model — distinct
        // from declaring no engine at all.
        const fake = agent({ health: { sessionId: "s1", engine: { provider: "mock", model: null } } as never })
        const agents = Agents({ fetch: fake.fetch })

        const result = await agents.attach("http://localhost:3010", { hydrate: false })

        expect(result.engine).toEqual({ provider: "mock", model: null })
    })

    it("reports null when the agent did not say", async () => {
        // An older agent. The row renders empty rather than inventing a
        // provider that was never declared.
        const fake = agent({ health: { sessionId: "s1" } })
        const agents = Agents({ fetch: fake.fetch })

        const result = await agents.attach("http://localhost:3010", { hydrate: false })

        expect(result.engine).toBeNull()
    })
})

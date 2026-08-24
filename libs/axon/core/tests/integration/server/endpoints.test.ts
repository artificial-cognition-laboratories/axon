import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

/**
 * The framework-reserved /_axon/* surface — behaviour-driven, through the real
 * server fetch handler. This is the wire contract AxonCloud.attach() speaks to,
 * so we exercise it exactly as a remote client would: an HTTP Request in, a
 * Response out. No internals — the handler is the public boundary.
 */
describe("/_axon endpoints", () => {
    function call(runtime: Awaited<ReturnType<typeof Axon>>, path: string, init?: RequestInit) {
        return runtime.server.handler(new Request(`http://agent${path}`, init))
    }

    it("GET /_axon/health returns ok once the runtime is serving", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

        const res = await call(runtime, "/_axon/health")
        expect(res.status).toBe(200)
        const health = await res.json()
        expect(health.ok).toBe(true)
        expect(typeof health.sessionId).toBe("string")

        await runtime.shutdown()
    })

    it("POST /_axon/request runs an invocation and returns AxonResult JSON", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })

        const res = await call(runtime, "/_axon/request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "hello" }),
        })

        expect(res.status).toBe(200)
        const result = await res.json()
        expect(result.text).toBe("Hi there!")
        expect(Array.isArray(result.entries)).toBe(true)

        await runtime.shutdown()
    })

    it("POST /_axon/request rejects a body with no usable prompt", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

        const res = await call(runtime, "/_axon/request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notAPrompt: 1 }),
        })

        expect(res.status).toBe(400)

        await runtime.shutdown()
    })

    it("POST /_axon/stream streams AxonEntry events as SSE and closes with a done frame", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })

        const res = await call(runtime, "/_axon/stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "hello" }),
        })

        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("text/event-stream")

        const text = await res.text()
        // At least one data frame, terminated by the explicit done event.
        expect(text).toContain("data:")
        expect(text).toContain("event: done")

        await runtime.shutdown()
    })

    it("the /_axon surface is present regardless of user routes (empty blueprint)", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

        // No user routes declared, yet the framework surface answers.
        expect((await call(runtime, "/_axon/health")).status).toBe(200)

        await runtime.shutdown()
    })

    /**
     * The session snapshot is what lets a deployed agent render identically to a
     * local one: a remote client has no in-process session, so it hydrates here
     * and appends from the stream. These assert the contract that makes that
     * safe — the delta is exact, and a capped response says so.
     */
    describe("GET /_axon/session", () => {
        it("returns the live session with all three logs", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })
            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })

            const res = await call(runtime, "/_axon/session")
            expect(res.status).toBe(200)

            const snapshot = await res.json()
            expect(snapshot.id).toBe(runtime.axon.session.id)
            expect(snapshot.entries.length).toBeGreaterThan(0)
            expect(Array.isArray(snapshot.log)).toBe(true)
            expect(Array.isArray(snapshot.kernelLog)).toBe(true)
            expect(snapshot.truncated).toBe(false)
            // The cursor is the high-water seq a client resumes from.
            expect(snapshot.cursor).toBeGreaterThan(0)

            await runtime.shutdown()
        })

        it("since= returns only events after the cursor, so hydrate+stream never double-counts", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } } })
            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })

            const first = await (await call(runtime, "/_axon/session")).json()

            // Asking again from the cursor yields nothing new — the exact
            // property a client relies on to avoid replaying its own history.
            const delta = await (await call(runtime, `/_axon/session?since=${first.cursor}`)).json()
            expect(delta.entries).toEqual([])
            expect(delta.log).toEqual([])
            expect(delta.kernelLog).toEqual([])

            // A second invocation appears in the next delta.
            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })
            const second = await (await call(runtime, `/_axon/session?since=${first.cursor}`)).json()
            expect(second.entries.length).toBeGreaterThan(0)
            expect(second.cursor).toBeGreaterThan(first.cursor)

            await runtime.shutdown()
        })

        it("include= omits the logs a client does not want", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi!" })] } } })
            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })

            const res = await call(runtime, "/_axon/session?include=entries")
            const snapshot = await res.json()

            expect(snapshot.entries.length).toBeGreaterThan(0)
            expect(snapshot.kernelLog).toEqual([])
            expect(snapshot.log).toEqual([])

            await runtime.shutdown()
        })

        it("limit= returns the most recent events and reports truncation", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi!" })] } } })
            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })

            const full = await (await call(runtime, "/_axon/session?include=entries")).json()
            const capped = await (await call(runtime, "/_axon/session?include=entries&limit=1")).json()

            expect(capped.entries).toHaveLength(1)
            // A partial view must never claim to be complete.
            expect(capped.truncated).toBe(true)
            // Most recent, not oldest.
            expect(capped.entries[0]).toEqual(full.entries.at(-1))

            await runtime.shutdown()
        })

        it("rejects malformed query params instead of silently defaulting", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

            // A since= that parsed as 0 would resend the whole history and look
            // like duplicated messages in the client — a 400 is the honest answer.
            expect((await call(runtime, "/_axon/session?since=abc")).status).toBe(400)
            expect((await call(runtime, "/_axon/session?since=-1")).status).toBe(400)
            expect((await call(runtime, "/_axon/session?include=nonsense")).status).toBe(400)

            await runtime.shutdown()
        })
    })

    /**
     * The ambient event channel. This is the one that replaces polling: a client
     * subscribes, gets history replayed from its cursor, and continues into the
     * live feed with no gap. The replay/live boundary is the part that has to be
     * exact — an event emitted while the replay is being written must arrive
     * once, not zero or twice.
     */
    describe("GET /_axon/events", () => {
        /** Read SSE frames until the `live` marker, then return what was replayed. */
        async function readUntilLive(res: Response): Promise<{ replayed: unknown[]; cursor: number | null }> {
            const reader = res.body!.getReader()
            const decoder = new TextDecoder()
            const replayed: unknown[] = []
            let buffer = ""
            let cursor: number | null = null

            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })

                let boundary: number
                while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                    const frame = buffer.slice(0, boundary)
                    buffer = buffer.slice(boundary + 2)
                    const type = frame.match(/^event:\s*(.*)$/m)?.[1]?.trim()
                    const data = frame.match(/^data:\s*(.*)$/m)?.[1]
                    if (type === "live") {
                        cursor = data ? (JSON.parse(data) as { cursor: number | null }).cursor : null
                        await reader.cancel()
                        return { replayed, cursor }
                    }
                    if (data) replayed.push(JSON.parse(data))
                }
            }
            return { replayed, cursor }
        }

        it("replays session history then signals live", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi!" })] } } })
            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })

            const res = await call(runtime, "/_axon/events")
            expect(res.status).toBe(200)
            expect(res.headers.get("content-type")).toContain("text/event-stream")

            const { replayed, cursor } = await readUntilLive(res)
            expect(replayed.length).toBeGreaterThan(0)
            expect(cursor).toBeGreaterThan(0)

            await runtime.shutdown()
        })

        it("replays in seq order across all three logs", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi!" })] } } })
            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })

            const { replayed } = await readUntilLive(await call(runtime, "/_axon/events"))
            const seqs = (replayed as { time: { seq: number } }[]).map(item => item.time.seq)

            // Interleaved entries/log/kernelLog must arrive in one ordered stream,
            // not concatenated per-log — a client appends in arrival order.
            expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

            await runtime.shutdown()
        })

        it("since= replays only the events after the cursor", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi!" })] } } })
            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })

            const full = await readUntilLive(await call(runtime, "/_axon/events"))
            const resumed = await readUntilLive(await call(runtime, `/_axon/events?since=${full.cursor}`))

            // Nothing left to replay — this is what makes reconnect trivial.
            expect(resumed.replayed).toEqual([])
            expect(resumed.cursor).toBe(full.cursor)

            await runtime.shutdown()
        })

        it("include= filters which logs reach the client", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi!" })] } } })
            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })

            const { replayed } = await readUntilLive(await call(runtime, "/_axon/events?include=entries"))
            const types = (replayed as { type: string }[]).map(item => item.type)

            expect(types.length).toBeGreaterThan(0)
            // kernel:* is the firehose a chat client does not want.
            expect(types.some(type => type.startsWith("kernel:"))).toBe(false)

            await runtime.shutdown()
        })

        it("streams events that happen after going live", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "Hi!" })] } } })

            const res = await call(runtime, "/_axon/events?include=entries")
            const reader = res.body!.getReader()
            const decoder = new TextDecoder()

            // Drain to the live marker first.
            let sawLive = false
            let buffer = ""
            while (!sawLive) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                if (buffer.includes("event: live")) sawLive = true
            }
            expect(sawLive).toBe(true)

            // Now drive a turn — its entries must arrive on this ambient stream,
            // which a request-scoped stream could never show a third party.
            const received = (async () => {
                let text = ""
                for (;;) {
                    const { done, value } = await reader.read()
                    if (done) return text
                    text += decoder.decode(value, { stream: true })
                    if (text.includes("cognet:output")) return text
                }
            })()

            await call(runtime, "/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hello" }),
            })

            expect(await received).toContain("cognet:output")
            await reader.cancel()

            await runtime.shutdown()
        })

        it("rejects malformed query params", async () => {
            const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

            expect((await call(runtime, "/_axon/events?since=abc")).status).toBe(400)
            expect((await call(runtime, "/_axon/events?include=nope")).status).toBe(400)

            await runtime.shutdown()
        })
    })
})

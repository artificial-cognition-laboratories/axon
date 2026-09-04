import { Axon, driver } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"
import { run } from "@arcforge/engines/mock"
import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"

describe("kernel execution: tool calls", () => {
    it("executes a run() step in the real capsule and commits the result to the session", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ "/go": [run("1 + 1"), "done"] })] } },
        })

        await runtime.kernel.request({ content: "/go" })

        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")

        expect(result).toBeDefined()
        expect((result!.data as { ok: boolean }).ok).toBe(true)
        expect((result!.data as { content: string }).content).toBe("2")

        await runtime.shutdown()
    })

    it("commits the cognet:action:typescript entry with the code the engine emitted", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ "/go": [run("40 + 2"), "done"] })] } },
        })

        await runtime.kernel.request({ content: "/go" })

        const executed = runtime.session.entries.find(e => e.type === "cognet:action:typescript")

        expect((executed!.data as { content: string }).content).toBe("40 + 2")

        await runtime.shutdown()
    })

    it("links the result entry back to the typescript block it answers", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ "/go": [run("1 + 1"), "done"] })] } },
        })

        await runtime.kernel.request({ content: "/go" })

        const executed = runtime.session.entries.find(e => e.type === "cognet:action:typescript")!
        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")!

        // `for` references the cognet:action:typescript block's own minted id
        // (data.id) — the kernel mints this id itself in runAndCommit(),
        // independent of any AIR-level parse id the engine wire carried.
        expect((result.data as { for: string }).for).toBe((executed.data as { id: string }).id)

        await runtime.shutdown()
    })

    it("commits a failed result (ok: false) when the executed code throws", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ "/go": [run(`throw new Error("boom")`), "done"] })] } },
        })

        await runtime.kernel.request({ content: "/go" })

        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")

        expect((result!.data as { ok: boolean }).ok).toBe(false)

        await runtime.shutdown()
    })

    it("quarantines leaked provider control preambles instead of replaying them as tool calls", async () => {
        let calls = 0
        const def: AxonEngineDef = {
            name: "control-preamble",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    calls++
                    const text = calls === 1
                        ? "<script>tagger to=fs.read accidental-json\\nconst answer = 42\\nanswer</script>"
                        : "<text>recovered</text><done/>"
                    yield { type: "text:delta", content: text }
                    yield {
                        type: "done",
                        response: {
                            text,
                            stopReason: "end",
                            meta: { provider: "control-preamble", model: "test", durationMs: 1 },
                        },
                    }
                },
            }),
        }
        const runtime = await Axon({
            blueprint: { config: { providers: [driver(def)] } },
        })

        await runtime.kernel.request({ content: "/go" })

        // It was never TypeScript and never reached the capsule, so it must
        // not become a prior assistant <script> the next completion copies.
        expect(runtime.session.entries.some(
            e => e.type === "cognet:action:typescript" && String(e.data.content).includes("tagger to="),
        )).toBe(false)
        expect(runtime.session.entries.some(e => e.type === "cognet:action:result")).toBe(false)

        const fault = runtime.session.entries.find(
            e => e.type === "axon:system:message" && e.data.type === "format-violation",
        )
        expect(fault).toBeDefined()
        expect(String(fault!.data.content)).toContain("Script not run")
        expect(String(fault!.data.content)).toContain("tagger to=")

        expect(runtime.session.entries.some(
            e => e.type === "cognet:output:text" && e.data.content === "recovered",
        )).toBe(true)

        await runtime.shutdown()
    })

    it("interrupts capsule execution and causally closes the tool call", async () => {
        const runtime = await Axon({
            blueprint: {
                config: {
                    providers: [Mock({
                        "/go": [run(`await new Promise(r => setTimeout(r, 10_000)); "unreachable"`), "also unreachable"],
                    })],
                },
            },
        })

        const invocation = runtime.axon.stream("/go")
        const drain = (async () => {
            for await (const _ of invocation.stream) { /* drain */ }
        })()

        // Wait until the code block is durable so this specifically exercises
        // act-phase cancellation rather than engine-stream cancellation.
        while (!runtime.session.entries.some(e => e.type === "cognet:action:typescript")) {
            await Bun.sleep(5)
        }
        invocation.interrupt()
        await drain

        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")
        expect(result).toBeDefined()
        expect((result!.data as { ok: boolean }).ok).toBe(false)
        expect((result!.data as { error?: { kind: string } }).error?.kind).toBe("interrupt")
        expect(runtime.session.entries.some(e => e.type === "axon:interrupt")).toBe(true)
        expect(runtime.session.kernelLog.some(e => e.type === "kernel:run:interrupted")).toBe(true)

        await runtime.shutdown()
    })

    it("a batch interrupted partway does not run the blocks it had not started", async () => {
        /**
         * The destructive case that survived until now.
         *
         * ONE long command is already killed on abort — procs.ts kills the
         * child's process tree. What was not killed is a SEQUENCE: a turn
         * emitting several blocks dispatches them together, so every remaining
         * block still executed after the user pressed Escape. Forty small
         * writes finishing past an interrupt is worse than one big one, because
         * nothing stops it.
         *
         * The kernel cannot cancel a tool already inside an `await` without
         * every module author threading a signal — a contract this system
         * deliberately does not impose. So it stops the sequence instead: a
         * block that has not STARTED does not start once the wake is cancelled.
         *
         * Asserted through the RESULTS rather than a count, because the fix
         * must not lose the blocks that genuinely ran.
         */
        const runtime = await Axon({
            blueprint: {
                config: {
                    providers: [Mock({
                        "/go": [
                            // The first blocks long enough to interrupt during.
                            run(`await new Promise(r => setTimeout(r, 10_000)); "first"`),
                            run(`"second"`),
                            run(`"third"`),
                            "done",
                        ],
                    })],
                },
            },
        })

        const invocation = runtime.axon.stream("/go")
        const drain = (async () => {
            for await (const _ of invocation.stream) { /* drain */ }
        })()

        while (!runtime.session.entries.some(e => e.type === "cognet:action:typescript")) {
            await Bun.sleep(5)
        }
        invocation.interrupt()
        await drain

        const results = runtime.session.entries.filter(e => e.type === "cognet:action:result")

        // Every result that exists reports honestly — nothing claims success
        // after the interrupt.
        for (const result of results) {
            expect((result.data as { ok: boolean }).ok).toBe(false)
        }

        // And the wake is recorded as interrupted rather than completed.
        expect(runtime.session.kernelLog.some(e => e.type === "kernel:run:interrupted")).toBe(true)
        expect(runtime.session.kernelLog.some(e => e.type === "kernel:run:complete")).toBe(false)

        await runtime.shutdown()
    })

    it("allows text and done emitted after executable code in the same model turn, and still executes the code", async () => {
        let call = 0
        const engine: AxonEngineDef = {
            name: "code-then-text",
            create: () => ({
                async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                    call++
                    const text = call === 1
                        ? "<script>1 + 1</script><text>checking that now</text><done/>"
                        : "<text>final answer</text><done/>"
                    yield { type: "text:delta", content: text }
                    yield {
                        type: "done",
                        response: {
                            text,
                            stopReason: "end",
                            meta: {
                                provider: "test",
                                model: "test",
                                tokens: { in: 0, out: 0, total: 0 },
                                durationMs: 0,
                            },
                        },
                    }
                },
            }),
        }
        const runtime = await Axon({ blueprint: { config: { providers: [driver(engine)] } } })

        const response = await runtime.axon.request("/go")

        expect(response.text).toContain("final answer")
        expect(runtime.session.entries.some(e => e.type === "cognet:output:text" && (e.data as { content: string }).content === "checking that now")).toBe(true)
        expect(runtime.session.entries.some(e => e.type === "cognet:action:result" && (e.data as { ok: boolean }).ok)).toBe(true)

        await runtime.shutdown()
    })
})

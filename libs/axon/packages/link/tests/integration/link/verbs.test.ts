import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve, connect, type LinkChannels, type SocketPaths } from "../../../src/socket"
import { SupervisorLink, supervisorHandlers, type SupervisorServices } from "../../../src/supervisor"
import { agentHandlers, supervisorProxy, RemoteDriver, type AgentServices } from "../../../src/agent"
import { describe, it, expect, beforeEach, afterEach } from "bun:test"

/**
 * The verbs, end to end, over real sockets.
 *
 * A supervisor and an agent wired exactly as they will be in production — the
 * supervisor holding the driver, the log and the decider; the agent holding
 * cognition and asking for what it may not keep. What is asserted here is the
 * CONTRACT (`SupervisorToAgent` / `AgentToSupervisor`), not the transport,
 * which the socket suite already covers.
 */
describe("link verbs — supervisor ↔ agent", () => {
    let dir: string
    let paths: SocketPaths
    let supervisorChannels: LinkChannels | null = null
    let agentChannels: LinkChannels | null = null
    const errors: Error[] = []

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "axon-verbs-"))
        paths = { control: join(dir, "c.sock"), data: join(dir, "d.sock") }
        errors.length = 0
    })

    afterEach(() => {
        agentChannels?.close()
        supervisorChannels?.close()
        agentChannels = null
        supervisorChannels = null
        rmSync(dir, { recursive: true, force: true })
    })

    async function wire(agent: Partial<AgentServices>, services: Partial<SupervisorServices> = {}) {
        const agentSide: AgentServices = {
            // ALL NINE verbs, matching what agentHandlers dispatches. The
            // default set had five — every test happened to supply whichever
            // it exercised, so the three missing ones (request, run, prompts,
            // serve) only surfaced once these tests were typechecked. A
            // fixture that is incomplete by default is a test asserting
            // against a shape the real agent never has.
            stimulus: async () => ({ admitted: true }),
            ingest: async () => {},
            request: async () => ({ ok: true }),
            run: async () => undefined,
            prompts: async () => undefined,
            serve: async (port: number) => ({ port }),
            update: async () => {},
            interrupt: () => {},
            shutdown: async () => {},
            // Only DEFINED overrides: spreading a Partial puts explicit
            // `undefined` over a required verb, which is exactly what the
            // defaults above exist to prevent.
            ...Object.fromEntries(Object.entries(agent).filter(([, v]) => v !== undefined)),
        }
        const supervisorSide: SupervisorServices = {
            async *infer() {},
            commit: () => {},
            ...services,
        }

        const serving = serve({
            paths,
            ...supervisorHandlers(supervisorSide),
            onError: e => errors.push(e),
        })
        agentChannels = await connect({
            paths,
            ...agentHandlers(agentSide),
            onError: e => errors.push(e),
        })
        supervisorChannels = await serving

        return {
            supervisor: SupervisorLink({ channels: supervisorChannels, services: supervisorSide, onError: e => errors.push(e) }),
            fromAgent: supervisorProxy(agentChannels),
        }
    }

    describe("supervisor → agent", () => {
        it("delivers a stimulus and reports admission", async () => {
            const seen: unknown[] = []
            const { supervisor } = await wire({
                stimulus: async entry => { seen.push(entry); return { admitted: true } },
            })
            expect(await supervisor.stimulus({ type: "text", content: "hi" } as never)).toEqual({ admitted: true })
            expect(seen).toHaveLength(1)
        })

        it("carries a REFUSED stimulus as a verdict, not an error", async () => {
            // The scheduler may drop one arriving mid-wake. That is the mind's
            // own admission policy answering, not a transport failure.
            const { supervisor } = await wire({ stimulus: async () => ({ admitted: false }) })
            expect((await supervisor.stimulus({} as never)).admitted).toBe(false)
        })

        it("hot-reloads through update", async () => {
            let applied = false
            const { supervisor } = await wire({ update: async () => { applied = true } })
            await supervisor.update({} as never)
            expect(applied).toBe(true)
        })

        it("lands an interrupt while inference streams on the other channel", async () => {
            // The reason there are two channels: on one socket this would queue
            // behind exactly the traffic it exists to stop.
            let interrupted: string | null = null
            const { supervisor, fromAgent } = await wire(
                { interrupt: reason => { interrupted = reason } },
                {
                    async *infer(_call, signal) {
                        while (!signal.aborted) {
                            yield { type: "text:delta", content: "tok" } as never
                            await new Promise(r => setTimeout(r, 5))
                        }
                    },
                },
            )

            const controller = new AbortController()
            let seen = 0
            const consume = (async () => {
                try {
                    for await (const _ of fromAgent.infer({ role: "main", request: {} as never }, controller.signal)) {
                        if (++seen === 3) supervisor.interrupt("user")
                    }
                } catch { /* abort surfaces as a throw */ }
            })()

            await new Promise(r => setTimeout(r, 80))
            expect(interrupted as string | null).toBe("user")
            controller.abort()
            await consume
        })

        it("drains through shutdown", async () => {
            let drained = false
            const { supervisor } = await wire({ shutdown: async () => { drained = true } })
            await supervisor.shutdown()
            expect(drained).toBe(true)
        })

        it("has no wake verb — the outside stimulates, the brain decides", async () => {
            const { supervisor } = await wire({})
            expect("wake" in supervisor).toBe(false)
        })
    })

    describe("agent → supervisor", () => {
        it("streams inference without ever seeing a credential", async () => {
            // The agent names a ROLE. No model id, no provider, no key crosses.
            let sawRole: string | null = null
            const { fromAgent } = await wire({}, {
                async *infer(call) {
                    sawRole = call.role
                    yield { type: "text:delta", content: "he" } as never
                    yield { type: "text:delta", content: "llo" } as never
                    yield { type: "done", response: { text: "hello" } } as never
                },
            })

            const seen: string[] = []
            for await (const event of fromAgent.infer({ role: "main", request: {} as never }, new AbortController().signal)) {
                if ((event as { type: string }).type === "text:delta") seen.push((event as { content: string }).content)
            }
            expect(seen.join("")).toBe("hello")
            expect(sawRole as string | null).toBe("main")
        })

        it("appends to the log without being able to rewrite it", async () => {
            // commit is the ONLY door to the record. There is no read verb and
            // no write verb — an attacker who can rewrite the audit trail has
            // erased the evidence of everything else.
            const committed: string[] = []
            const { fromAgent } = await wire({}, { commit: type => { committed.push(type as string) } })

            fromAgent.commit("process:proc:start", {} as never)
            fromAgent.commit("cognet:load:start", {} as never)
            await new Promise(r => setTimeout(r, 50))

            expect(committed).toEqual(["process:proc:start", "cognet:load:start"])
        })

        it("keeps the existing event vocabulary so Fleet keeps working", async () => {
            // Fleet folds its flame graph and process tree straight out of this
            // stream, and procTree() reads the same names.
            const committed: string[] = []
            const { fromAgent } = await wire({}, { commit: type => { committed.push(type as string) } })
            fromAgent.commit("process:proc:complete", {} as never)
            await new Promise(r => setTimeout(r, 50))
            expect(committed).toEqual(["process:proc:complete"])
        })

        it("reaches a human through escalate", async () => {
            const { fromAgent } = await wire({}, { escalate: async () => ({ allow: true }) })
            expect(await fromAgent.escalate({ fn: "process.run", args: ["rm -rf /"] } as never)).toEqual({ allow: true })
        })

        it("fails escalation CLOSED when no decider is attached", async () => {
            // A headless run has nobody to ask. An unanswered escalation must
            // never read as permission.
            const { fromAgent } = await wire({}, {})
            expect(await fromAgent.escalate({} as never)).toEqual({ allow: false })
        })
    })

    describe("RemoteDriver — inference as an ordinary driver", () => {
        it("preserves a retryable engine fault from the supervisor", async () => {
            const fault = {
                code: "EMPTY_RESPONSE" as const,
                message: "codex: empty response from model \\\"gpt-test\\\"",
                retryable: true,
                provider: "codex",
                model: "gpt-test",
            }
            const { fromAgent } = await wire({}, {
                async *infer() { throw Object.assign(new Error(fault.message), { fault }) },
            })
            const driver = RemoteDriver({ role: "main", supervisor: fromAgent })

            try {
                await Array.fromAsync(driver.stream({ messages: [] } as never))
                throw new Error("expected remote inference to fail")
            } catch (error) {
                expect(error).toMatchObject({ fault })
            }
        })

        it("satisfies AxonEngineDriver so the Engine manager cannot tell it is remote", async () => {
            // The whole trick: AxonEngineDriver is already "a dumb token pipe",
            // which is what a wire is. AIR parsing, retries and the stall guard
            // stay agent-side and never learn the tokens crossed a boundary.
            const { fromAgent } = await wire({}, {
                async *infer() {
                    yield { type: "text:delta", content: "<text>hi</text>" } as never
                    yield { type: "done", response: { text: "<text>hi</text>" } } as never
                },
            })

            const driver = RemoteDriver({ role: "main", supervisor: fromAgent })
            const events: string[] = []
            for await (const event of driver.stream({ messages: [] } as never)) {
                events.push((event as { type: string }).type)
            }
            expect(events).toEqual(["text:delta", "done"])
        })

        it("uses the REQUEST's signal, not one captured at construction", async () => {
            // The bug this pins: `Axon()` builds the driver as
            // `role => RemoteDriver({ role, supervisor })` — long before any
            // wake exists — so a driver reading `opts.signal` handed every
            // stream a fresh controller nobody ever aborted. Interrupt reached
            // the scheduler, the scheduler aborted the wake, and the engine
            // stream ran to completion anyway: the spinner stopped, the reply
            // arrived regardless, and the interrupt marker appeared after it.
            //
            // The kernel INJECTS the wake's signal into every call
            // (`streamAndRecord`: "a program that forgot to thread a signal
            // made one unkillable"), so the request's signal is the only one
            // that carries a real cancellation.
            let stopped = false
            const { fromAgent } = await wire({}, {
                async *infer(_call, signal) {
                    signal.addEventListener("abort", () => { stopped = true })
                    while (!signal.aborted) {
                        yield { type: "text:delta", content: "x" } as never
                        await new Promise(r => setTimeout(r, 5))
                    }
                },
            })

            // No construction-time signal — exactly how Axon() builds it.
            const driver = RemoteDriver({ role: "main", supervisor: fromAgent })
            const controller = new AbortController()

            let seen = 0
            try {
                // The signal arrives on the REQUEST, as the kernel sends it.
                for await (const _ of driver.stream({ messages: [], signal: controller.signal } as never)) {
                    if (++seen === 2) controller.abort()
                }
            } catch { /* abort surfaces as a throw */ }

            await new Promise(r => setTimeout(r, 40))
            expect(stopped).toBe(true)
        })

        it("carries the wake's cancellation through to the producer", async () => {
            // A kill must reach the thing spending money — an abandoned stream
            // that keeps generating tokens is a bill nobody asked for.
            let stopped = false
            const { fromAgent } = await wire({}, {
                async *infer(_call, signal) {
                    signal.addEventListener("abort", () => { stopped = true })
                    while (!signal.aborted) {
                        yield { type: "text:delta", content: "x" } as never
                        await new Promise(r => setTimeout(r, 5))
                    }
                },
            })

            const controller = new AbortController()
            const driver = RemoteDriver({ role: "main", supervisor: fromAgent, signal: controller.signal })
            let seen = 0
            try {
                for await (const _ of driver.stream({ messages: [] } as never)) {
                    if (++seen === 2) controller.abort()
                }
            } catch { /* abort surfaces as a throw */ }

            await new Promise(r => setTimeout(r, 40))
            expect(stopped).toBe(true)
        })
    })
})

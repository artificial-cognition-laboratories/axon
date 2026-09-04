import { AgentRuntime, type RuntimeForAgent } from "../../src/runtime"
import { describe, it, expect } from "bun:test"

/**
 * AgentRuntime adapts a live Axon() runtime to the four verbs a supervisor may
 * invoke. The subtle one is `stimulus`, and it is subtle for a reason worth
 * restating: ADMISSION is the contract, not completion.
 *
 * A continuous cognet ticks whether or not the last wake finished. If this
 * resolved on completion, every stimulus would serialise behind the previous
 * wake and a mind under a clock would become a queue — the exact failure the
 * scheduler's overlapping-wake design exists to avoid.
 */
function runtime(over: Partial<RuntimeForAgent["kernel"]> & { update?: RuntimeForAgent["update"]; shutdown?: RuntimeForAgent["shutdown"] } = {}): RuntimeForAgent {
    return {
        kernel: {
            request: over.request ?? (async () => ({})),
            ingest: over.ingest ?? (async () => {}),
            interrupt: over.interrupt ?? (() => {}),
            // `run` is part of the kernel surface the agent side dispatches.
            // The fixture omitted it, so every test built a runtime shaped
            // unlike the real one.
            run: over.run ?? (async () => ({})),
        },
        // `server` and `axon` complete RuntimeForAgent. AgentRuntime dispatches
        // `serve` and `prompts` through them, so a fixture without them is a
        // runtime the adapter could never actually be handed.
        server: { get handler() { return () => new Response("ok") } },
        axon: {
            prompt: async () => "",
            prompts: { list: () => [], renderEntry: async () => "" },
        },
        update: over.update ?? (async () => ({})),
        shutdown: over.shutdown ?? (async () => ({})),
    }
}

/** The error the scheduler throws when an invocation cognet is already busy. */
function runInProgress(): Error & { code: string } {
    const error = new Error("RUN_IN_PROGRESS") as Error & { code: string }
    error.code = "AX-KERNEL-RUN_IN_PROGRESS"
    return error
}

describe("AgentRuntime — stimulus admission", () => {
    it("admits a stimulus the brain accepted", async () => {
        const agent = AgentRuntime(runtime())
        expect(await agent.stimulus({ data: { content: "hi" } } as never)).toEqual({ admitted: true })
    })

    it("does NOT wait for the wake to finish", async () => {
        // The property that keeps a continuous cognet from serialising.
        let settled = false
        const agent = AgentRuntime(runtime({
            request: () => new Promise(resolve => setTimeout(() => { settled = true; resolve({}) }, 400)),
        }))

        const started = Date.now()
        expect(await agent.stimulus({ data: { content: "slow" } } as never)).toEqual({ admitted: true })
        expect(Date.now() - started).toBeLessThan(150)
        expect(settled).toBe(false)
    })

    it("reports a REFUSAL as a verdict, not an exception", async () => {
        // An invocation cognet IS one conversation, so a second concurrent
        // stimulus is the mind declining — an answer, not a broken runtime.
        const agent = AgentRuntime(runtime({ request: async () => { throw runInProgress() } }))
        expect(await agent.stimulus({ data: { content: "second" } } as never)).toEqual({ admitted: false })
    })

    it("propagates a REAL fault instead of disguising it as a refusal", async () => {
        // A stimulus that failed for an unknown reason must never read as a
        // polite "not now" — that would hide a broken agent behind a verdict
        // the caller treats as normal.
        const agent = AgentRuntime(runtime({
            request: async () => { throw new Error("cognet exploded") },
        }))
        await expect(agent.stimulus({ data: { content: "x" } } as never)).rejects.toThrow("cognet exploded")
    })

    it("passes content and channel through to the kernel", async () => {
        let seen: unknown = null
        const agent = AgentRuntime(runtime({ request: async input => { seen = input; return {} } }))
        await agent.stimulus({ data: { content: "hello", channel: "telegram:42" } } as never)
        expect(seen).toEqual({ content: "hello", channel: "telegram:42" })
    })

    it("delivers a contentless stimulus as a bare wake trigger", async () => {
        // A sensor reading has no text. Forcing it into a content field would
        // put a fabricated message in the timeline.
        let seen: unknown = null
        const agent = AgentRuntime(runtime({ request: async input => { seen = input; return {} } }))
        await agent.stimulus({ data: { reading: 21.5 } } as never)
        expect(seen).toEqual({})
    })

    it("does not crash the process when an unobserved wake rejects later", async () => {
        // The wake is started, not awaited. An unhandled rejection from it
        // would take down the whole agent.
        const agent = AgentRuntime(runtime({
            request: () => new Promise((_r, reject) => setTimeout(() => reject(new Error("late failure")), 20)),
        }))
        expect(await agent.stimulus({ data: { content: "x" } } as never)).toEqual({ admitted: true })
        await new Promise(r => setTimeout(r, 60))
        // Reaching here without an unhandled rejection is the assertion.
        expect(true).toBe(true)
    })
})

describe("AgentRuntime — the other three verbs", () => {
    it("replaces the blueprint rather than merging it", async () => {
        // The supervisor sends a fully re-normalised blueprint. Merging would
        // let a field the reload deliberately dropped survive it.
        let mode: string | undefined
        const agent = AgentRuntime(runtime({
            update: async (_bp, opts) => { mode = opts?.mode; return {} },
        }))
        await agent.update({} as never)
        expect(mode).toBe("replace")
    })

    it("forwards an interrupt with its reason", () => {
        let reason: string | null = null
        const agent = AgentRuntime(runtime({ interrupt: r => { reason = r } }))
        agent.interrupt("user")
        expect(reason as string | null).toBe("user")
    })

    it("shuts down naming the supervisor as the cause", async () => {
        let why: string | undefined
        const agent = AgentRuntime(runtime({ shutdown: async reason => { why = reason; return {} } }))
        await agent.shutdown()
        expect(why).toBe("supervisor")
    })
})

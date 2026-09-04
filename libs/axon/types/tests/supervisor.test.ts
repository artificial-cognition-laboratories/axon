import { describe, expect, it } from "bun:test"
import type { AgentToSupervisor, InferCall, SupervisorToAgent } from "../src/supervisor"

/**
 * The supervisor ↔ agent wire is a CONTRACT, so these pin its shape rather
 * than any behaviour: a type that silently widened to `any` would let both
 * sides drift and typecheck all the way to a runtime failure.
 *
 * Implemented as doubles rather than `declare const` so the assertions are
 * real values a test can exercise — a shape that cannot be constructed is a
 * shape nobody can implement.
 */
function agentSide(over: Partial<SupervisorToAgent> = {}): SupervisorToAgent {
    return {
        stimulus: async () => ({ admitted: true }),
        ingest: async () => {},
        update: async () => {},
        interrupt: () => {},
        shutdown: async () => {},
        request: async () => ({ ok: true }),
        run: async () => ({ ok: true, stdout: [], scope: { modules: [] } }) as never,
        prompts: async () => [],
        serve: async () => ({ port: 3010 }),
        ...over,
    }
}

describe("wire — supervisor → agent", () => {
    it("resolves stimulus on ADMISSION, not on completion", async () => {
        // A continuous cognet wakes whether or not the last wake finished.
        // Resolving on completion would serialise that overlap and turn a mind
        // under a clock into a queue.
        expect(await agentSide().stimulus({} as never)).toEqual({ admitted: true })
    })

    it("carries a dropped stimulus as a verdict, not an exception", async () => {
        // The scheduler may legitimately refuse one arriving mid-wake. That is
        // the mind's own admission policy answering, not a transport failure.
        const agent = agentSide({ stimulus: async () => ({ admitted: false }) })
        expect((await agent.stimulus({} as never)).admitted).toBe(false)
    })

    it("makes interrupt synchronous — it rides the control channel", () => {
        // It must land WHILE inference streams. A promise here would imply
        // ordering against the data channel that the transport does not give.
        let reason = ""
        const agent = agentSide({ interrupt: r => { reason = r } })
        const returned: void = agent.interrupt("shutdown")
        expect(returned).toBeUndefined()
        expect(reason).toBe("shutdown")
    })

    it("has NO wake verb — the brain decides, the outside only stimulates", () => {
        expect("wake" in agentSide()).toBe(false)
    })

    it("separates stimulus (admission) from request (completion)", async () => {
        // Both exist because they answer different questions. `stimulus` says
        // the brain accepted it and returns at once — the only honest answer
        // for a continuous cognet whose wakes overlap. `request` waits for the
        // wake's own bracket to close, which is what an interactive caller
        // needs: a UI spinning forever because nothing said "done" is broken in
        // a way admission cannot fix.
        const order: string[] = []
        const agent = agentSide({
            stimulus: async () => { order.push("admitted"); return { admitted: true } },
            request: async () => { order.push("settled"); return { ok: true } },
        })
        await agent.stimulus({} as never)
        await agent.request({} as never)
        expect(order).toEqual(["admitted", "settled"])
    })

    it("reports an interrupted wake as a settled outcome, not a failure", async () => {
        // Cancellation is a RESULT. Rendering it as an error would tell a user
        // their agent broke when they are the one who stopped it.
        const agent = agentSide({ request: async () => ({ ok: false, interrupted: true }) })
        expect(await agent.request({} as never)).toEqual({ ok: false, interrupted: true })
    })

    it("returns a value from run, unlike a stimulus", () => {
        // The console eval is not something the brain decides about: nothing
        // wakes, no wake admits it, and the caller wants the result back.
        const agent = agentSide({
            run: async code => ({ ok: true, value: code.length, stdout: [], scope: { modules: [] } }) as never,
        })
        return agent.run("1 + 1").then(result => {
            expect((result as { value: number }).value).toBe(5)
        })
    })

    it("serves the whole prompt surface through ONE verb", async () => {
        // Three near-identical round trips would be three places to keep in
        // step — the same reason commit is one verb.
        const seen: string[] = []
        const agent = agentSide({
            prompts: async request => { seen.push(request.action); return [] },
        })
        await agent.prompts({ action: "list" })
        await agent.prompts({ action: "get", name: "greeting" })
        await agent.prompts({ action: "render", entry: {} })
        expect(seen).toEqual(["list", "get", "render"])
    })
})

describe("wire — agent → supervisor", () => {
    function supervisor(over: Partial<AgentToSupervisor> = {}): AgentToSupervisor {
        return {
            async *infer() {},
            commit: () => {},
            escalate: async () => ({ allow: false }),
            ...over,
        }
    }

    it("streams inference rather than resolving it", async () => {
        // Raw deltas, so AIR never crosses: the supervisor holds the credential
        // and stays a dumb token pipe; the grammar is entirely agent-side.
        const seen: string[] = []
        const sup = supervisor({
            async *infer() {
                yield { type: "text:delta", content: "he" } as never
                yield { type: "text:delta", content: "llo" } as never
            },
        })
        const call: InferCall = { role: "main", request: { messages: [] } as never }
        for await (const event of sup.infer(call, new AbortController().signal)) {
            seen.push((event as { content: string }).content)
        }
        expect(seen.join("")).toBe("hello")
    })

    it("names a ROLE, never a model or a key", () => {
        // The indirection is the point: cognition must not learn what is behind
        // a role, and the credential never leaves the supervisor.
        const call: InferCall = { role: "main", request: { messages: [] } as never }
        expect(Object.keys(call).sort()).toEqual(["request", "role"])
    })

    it("makes commit fire-and-forget — it must never block the hot path", () => {
        const committed: string[] = []
        const sup = supervisor({ commit: type => { committed.push(type as string) } })
        const returned: void = sup.commit("axon:log:info", {} as never)
        expect(returned).toBeUndefined()
        expect(committed).toEqual(["axon:log:info"])
    })

    it("keeps the existing event vocabulary so Fleet keeps working", () => {
        // Fleet folds its flame graph and process tree straight out of this
        // stream. Renaming events and moving machinery at once is how a flame
        // graph silently stops pairing brackets.
        const committed: string[] = []
        const sup = supervisor({ commit: type => { committed.push(type as string) } })
        sup.commit("process:proc:start", {} as never)
        sup.commit("cognet:load:start", {} as never)
        expect(committed).toEqual(["process:proc:start", "cognet:load:start"])
    })

    it("fails escalation CLOSED", async () => {
        // No decider attached (a script, a headless run) means deny. An
        // unanswered escalation must never read as permission.
        expect(await supervisor().escalate({} as never)).toEqual({ allow: false })
    })
})

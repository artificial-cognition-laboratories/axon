import { Channel, type ChannelHandlers } from "../../src/channel"
import { supervisorHandlers, agentServices } from "../../src/supervisor"
import type { AxonCommitContext, AxonEventMap } from "@arcforge/types"
import { describe, it, expect } from "bun:test"

/**
 * Correlation ids must survive the supervisor link.
 *
 * The agent's kernel mints ONE spanId per engine call, and
 * `kernel:engine:start`, `:input` and `:complete` are joined by nothing else.
 * So when `commit` could only carry `(type, data)`, moving agents into
 * subprocesses meant every one of those ids died at the process boundary: the
 * supervisor re-enveloped with a fresh `time` and no `context`, and every
 * surface that correlates spans — the Engine/AIR view most visibly — rendered
 * empty for every session while looking merely idle.
 *
 * That is the regression these pin. `ctx` is part of the wire contract, not
 * decoration on the payload, so it is asserted at the seam itself: what
 * `agentServices` sends is what `supervisorHandlers` delivers.
 */
function pair(handlers: ChannelHandlers) {
    let left: ReturnType<typeof Channel>
    let right: ReturnType<typeof Channel>

    left = Channel({
        socket: { write: d => { right.receive(d); return d.byteLength }, close: () => {} },
        handlers: {},
        onError: () => {},
    })
    right = Channel({
        socket: { write: d => { left.receive(d); return d.byteLength }, close: () => {} },
        handlers,
        onError: () => {},
    })
    return left
}

/** One agent→supervisor commit, as it arrives on the far side. */
type Received = { type: string; data: unknown; ctx?: AxonCommitContext }

function wire() {
    const received: Received[] = []
    const services = {
        infer: () => { throw new Error("not used") },
        commit: (type: keyof AxonEventMap, data: unknown, ctx?: AxonCommitContext) => {
            received.push({ type: type as string, data, ctx })
        },
    }
    const channel = pair(supervisorHandlers(services as never).data as ChannelHandlers)
    const agent = agentServices({ data: channel, control: channel } as never)
    return { agent, received }
}

describe("commit context across the link", () => {
    it("delivers the correlation ids the agent committed with", async () => {
        const { agent, received } = wire()
        const ctx = { runId: "run-1", spanId: "span-1" }

        agent.commit("kernel:engine:input" as never, { messages: [], bytes: 0 } as never, ctx)
        await Bun.sleep(10)

        expect(received).toHaveLength(1)
        expect(received[0]!.ctx).toEqual(ctx)
    })

    it("keeps the three events of one engine call on the same span", async () => {
        // The whole point: start/input/complete are correlated by spanId and
        // by nothing else. A seam that dropped it left three unrelated events.
        const { agent, received } = wire()
        const ctx = { runId: "run-1", spanId: "span-1" }

        agent.commit("kernel:engine:start" as never, { provider: "test" } as never, ctx)
        agent.commit("kernel:engine:input" as never, { messages: [], bytes: 0 } as never, ctx)
        agent.commit("kernel:engine:complete" as never, { text: "hi" } as never, ctx)
        await Bun.sleep(10)

        expect(received.map(entry => entry.ctx?.spanId)).toEqual(["span-1", "span-1", "span-1"])
    })

    it("carries no context when the committer had none", async () => {
        // Absent must mean "there was none", never "the wire lost it" — so an
        // uncorrelated event arrives with ctx undefined rather than an empty
        // object the writer would stamp as a context key.
        const { agent, received } = wire()

        agent.commit("axon:log:error" as never, { message: "x" } as never)
        await Bun.sleep(10)

        expect(received[0]!.ctx).toBeUndefined()
    })

    it("does not smuggle the context into the payload", async () => {
        // ctx is part of the contract, not a field on data. Merging it in
        // would corrupt every payload shape the far side type-checks against.
        const { agent, received } = wire()

        agent.commit("kernel:engine:start" as never, { provider: "test" } as never, { spanId: "s" })
        await Bun.sleep(10)

        expect(received[0]!.data).toEqual({ provider: "test" })
    })
})

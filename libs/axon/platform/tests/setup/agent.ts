import type { AgentT } from "../../src/build/runtime/agent"

/**
 * "Is this agent alive and answering?" — for either kind of agent.
 *
 * Most tests reaching into an agent were asking exactly this: spawn it, break
 * something, and check the runtime still serves. They asked it as
 * `agent.current.axon.request(...)`, which reads the in-heap runtime directly.
 *
 * That stopped working when agents became processes — `current.axon` is
 * correctly absent for a linked agent, because there is no in-heap runtime to
 * hand out. The QUESTION is still valid and still has an answer; only the way
 * to ask it changed.
 *
 * So this asks it once, in the way each kind supports:
 *   process — `axon.request()`, the same call as before
 *   linked  — the link's `request` verb, which delivers a stimulus and
 *             resolves when the wake it caused settles
 *
 * Deliberately a helper rather than a branch at each site: twelve copies of
 * this narrowing would be twelve places to update the next time the shape
 * moves, and the tests are about the agent's health rather than about how a
 * caller reaches it.
 */
export async function ask(agent: AgentT, prompt: string): Promise<unknown> {
    if (agent.kind === "process") return agent.current.axon.request(prompt)

    const outcome = await agent.link.request({
        type: "cognet:stimulus:text",
        data: { content: prompt, channel: "test" },
    } as never)

    // A wake that ran is an answer. `request` resolves on the wake SETTLING,
    // so reaching here at all means the agent accepted the work and finished
    // it — which is what "alive and answering" was ever checking.
    if (!outcome.ok && !outcome.interrupted) {
        throw new Error(`agent did not answer: ${JSON.stringify(outcome)}`)
    }
    return outcome
}

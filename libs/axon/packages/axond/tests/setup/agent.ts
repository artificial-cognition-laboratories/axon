import type { AgentT } from "@arcforge/platform/build/runtime"

/**
 * "Is this agent alive and answering?"
 *
 * Most tests reaching into an agent are asking exactly this: spawn it, break
 * something, and check the runtime still serves.
 *
 * An agent is a PROCESS, reached over the link — there is no in-heap runtime
 * to call `axon.request()` on. `request` delivers a stimulus and resolves when
 * the wake it caused settles, which is the same question asked the only way
 * the transport supports.
 */
export async function ask(agent: AgentT, prompt: string): Promise<unknown> {
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

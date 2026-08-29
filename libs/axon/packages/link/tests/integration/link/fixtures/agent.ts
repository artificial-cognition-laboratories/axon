/**
 * A minimal agent process, for the end-to-end link test.
 *
 * Stands in for the real `Axon()` runtime: dials both channels using the env
 * carrier, serves the four verbs, and asks for the three it may not hold. What
 * it exercises is the PROCESS boundary — env carrier, dial-by-path, both
 * directions over real sockets — which is the only part a loopback test cannot
 * reach.
 */
import { connect } from "../../../../src/socket"
import { agentHandlers, supervisorProxy } from "../../../../src/agent"
import { readLinkEnv } from "../../../../src/entry"

const paths = readLinkEnv()
let stopping = false

const channels = await connect({
    paths,
    ...agentHandlers({
        async stimulus(entry) {
            const content = (entry as { data?: { content?: string } }).data?.content
            // Echo what we heard back through the log, so the supervisor can
            // observe that the stimulus actually arrived in the child.
            supervisor.commit("axon:log:info" as never, { message: `heard:${content}` } as never)
            return { admitted: content !== "busy" }
        },
        async update() {
            supervisor.commit("axon:log:info" as never, { message: "updated" } as never)
        },
        interrupt(reason) {
            supervisor.commit("axon:log:info" as never, { message: `interrupt:${reason}` } as never)
        },
        async run(code) {
            return { ok: true, value: `ran:${code}`, stdout: [], scope: { modules: [] } }
        },
        async prompts(request) {
            return { served: request.action, ...(request.name ? { name: request.name } : {}) }
        },
        async shutdown() {
            stopping = true
            supervisor.commit("axon:log:info" as never, { message: "shutdown" } as never)
        },
    }),
    onError: error => {
        process.stderr.write(`agent link error: ${error.message}\n`)
    },
})

const supervisor = supervisorProxy(channels)

// Prove the agent can reach inference without holding a credential.
if (process.env.AXON_TEST_INFER === "1") {
    let text = ""
    for await (const event of supervisor.infer({ role: "main", request: {} as never }, new AbortController().signal)) {
        const e = event as { type: string; content?: string }
        if (e.type === "text:delta") text += e.content ?? ""
    }
    supervisor.commit("axon:log:info" as never, { message: `inferred:${text}` } as never)
}

process.stdout.write("agent-ready\n")

// Stay alive until told to stop.
const timer = setInterval(() => {
    if (stopping) {
        clearInterval(timer)
        channels.close()
        process.exit(0)
    }
}, 10)

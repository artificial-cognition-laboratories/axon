import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"
import { run } from "@arcforge/engines/mock"
import type { AxonTool, EscalationCall } from "@arcforge/types"

/**
 * Escalation, end to end, against a REAL capsule.
 *
 * `escalate` was declared on the capsule from the start and only ever supplied
 * in the capsule's own tests — the kernel never passed one. So every rule
 * saying "escalate" meant "deny after a 30-second hang", in a system whose
 * whole policy vocabulary is allow/deny/escalate. These prove the wire, which
 * is the part that was missing rather than the part that was wrong.
 */

const greeterTool: AxonTool = {
    name: "greeter",
    fns: [{ name: "greet", declaration: "function greet(name: string): string" }],
    origin: "src",
    flat: true,
    source: `
        export default {
            name: "greeter",
            exports: {
                greet: (name) => "hello " + name,
            },
        }
    `,
}

function ranOk(runtime: { session: { entries: Array<{ type: string; data: unknown }> } }): boolean {
    const result = runtime.session.entries.find(e => e.type === "cognet:action:result")
    return (result?.data as { ok?: boolean } | undefined)?.ok === true
}

describe("kernel policy: escalation", () => {
    it("reaches the decider and allows when it says yes", async () => {
        const seen: EscalationCall[] = []

        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: "escalate" } },
                },
            },
            escalate: async call => {
                seen.push(call)
                return true
            },
        })

        await runtime.kernel.request({ content: "/go" })

        // The decider was actually consulted — not defaulted past.
        expect(seen.length).toBe(1)
        // The bare fn, because this tool is `flat` — its exports land as
        // top-level globals rather than under a namespace. Worth pinning:
        // a grant is keyed on the fn, so if this ever gained a prefix every
        // stored grant would silently stop matching.
        expect(seen[0]!.fn).toBe("greet")
        expect(ranOk(runtime)).toBe(true)

        await runtime.shutdown()
    })

    it("denies when the decider says no", async () => {
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: "escalate" } },
                },
            },
            escalate: async () => false,
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(false)

        await runtime.shutdown()
    })

    it("denies when no decider is wired at all", async () => {
        // The headless case — `axon run` in a script, a deployed agent. The
        // capsule's own posture is deny with no decider, and it must stay that
        // way: an escalation nobody can answer is not an implicit allow.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: "escalate" } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(false)

        await runtime.shutdown()
    })

    it("a decider that throws denies rather than crashing the wake", async () => {
        // A surface can fail — a palette mid-teardown, a disconnected editor.
        // The sandbox must never be left waiting on a policy answer, and a
        // broken decider must not take the agent down with it.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: "escalate" } },
                },
            },
            escalate: async () => { throw new Error("surface exploded") },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(false)

        await runtime.shutdown()
    })

    it("is never consulted for a rule that already decided", async () => {
        // Escalation is the "ask" verdict, not a hook on every call. A policy
        // that allows outright must not cost a round trip to a human.
        const seen: EscalationCall[] = []

        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: true } },
                },
            },
            escalate: async call => {
                seen.push(call)
                return true
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(seen.length).toBe(0)
        expect(ranOk(runtime)).toBe(true)

        await runtime.shutdown()
    })

    it("a profile ceiling of escalate asks even when the agent allows", async () => {
        // The ceiling and the escalation wire meeting: the agent granted
        // itself the tool, the machine said "ask me", and asking wins. An
        // agent author must not be able to suppress the owner's prompts.
        const seen: EscalationCall[] = []

        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                profilePolicy: { tools: { greeter: "escalate" } },
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: true } },
                },
            },
            escalate: async call => {
                seen.push(call)
                return true
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(seen.length).toBe(1)
        expect(ranOk(runtime)).toBe(true)

        await runtime.shutdown()
    })
})

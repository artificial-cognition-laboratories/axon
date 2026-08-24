import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"
import { run } from "@arcforge/engines/mock"
import type { AxonTool } from "@arcforge/types"

/**
 * The profile ceiling, enforced against a REAL capsule.
 *
 * A profile policy bounds every agent on the machine; an agent narrows within
 * it and can never widen it. The resolver's own unit tests pin the semantics —
 * these prove the wire: that `blueprint.profilePolicy` actually reaches the
 * subprocess and changes what a tool call does.
 *
 * That distinction matters here more than usual. A ceiling that resolves
 * correctly in a pure function and is dropped somewhere between the blueprint
 * and the mediator is worse than no ceiling: it reads as enforced in every
 * surface that shows it, while granting everything.
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

/** Did the tool actually run? */
function ranOk(runtime: { session: { entries: Array<{ type: string; data: unknown }> } }): boolean {
    const result = runtime.session.entries.find(e => e.type === "cognet:action:result")
    return (result?.data as { ok?: boolean } | undefined)?.ok === true
}

describe("kernel policy: the profile ceiling", () => {
    it("a profile denial overrides an agent that allows the same tool", async () => {
        // The whole point of a ceiling. The agent explicitly grants itself the
        // tool; the machine says no, and the machine wins.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                profilePolicy: { tools: { greeter: false } },
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: true } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(false)

        await runtime.shutdown()
    })

    it("an agent can still narrow below its profile", async () => {
        // Narrowing is always permitted — that is the composability the model
        // exists for: allow machine-wide, lock one agent down further.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                profilePolicy: { tools: { greeter: true } },
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: false } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(false)

        await runtime.shutdown()
    })

    it("a profile grant does not by itself grant — the agent's own default still applies", async () => {
        // A ceiling is an upper bound, never a grant. With both layers
        // permitting, the call goes through.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                profilePolicy: { tools: { greeter: true } },
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: true } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(true)

        await runtime.shutdown()
    })

    it("a profile that says nothing about a tool leaves the agent's default intact", async () => {
        // Silence is no opinion. A profile declaring one rule must not deny
        // every other capability on the machine, or adding a line to a profile
        // would break every agent on it.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                profilePolicy: { tools: { somethingElse: false } },
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    // No rule for greeter — Axon's allow-by-default applies.
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(true)

        await runtime.shutdown()
    })

    it("no profile policy at all behaves exactly as before", async () => {
        // The regression guard: every agent without a profile — a deployment,
        // `axon run` outside one — must be unaffected by the ceiling existing.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: true } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(true)

        await runtime.shutdown()
    })
})

/**
 * A profile BLANKET is still a ceiling.
 *
 * `tools: false` normalises to `{ "*": false }`, and the mediator prefers an
 * exact key over the wildcard — so an agent naming the tool would have been
 * handed its own `true` and the profile's blanket never consulted. A ceiling a
 * named grant can punch through is not a ceiling, and this is the case the
 * blanket form exists for: "deny everything, including whatever gets installed
 * next".
 */
describe("kernel policy: a blanket profile ceiling", () => {
    it("a profile denying EVERY tool overrides an agent that names one", async () => {
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                profilePolicy: { tools: false },
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: true } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(false)

        await runtime.shutdown()
    })

    it("a profile allowing EVERY tool still lets an agent narrow", async () => {
        // The blanket is a ceiling, not a floor — narrowing below it stays
        // permitted, which is the composability the whole model exists for.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                profilePolicy: { tools: true },
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: false } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(false)

        await runtime.shutdown()
    })

    it("a profile blanket allow leaves an agent that says nothing working", async () => {
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                profilePolicy: { tools: true },
                config: { providers: [Mock({ "/go": [run(`greet("world")`), "done"] })] },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        expect(ranOk(runtime)).toBe(true)

        await runtime.shutdown()
    })
})

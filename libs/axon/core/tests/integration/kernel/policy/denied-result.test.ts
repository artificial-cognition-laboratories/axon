import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"
import { run } from "@arcforge/engines/mock"
import type { AxonTool } from "@arcforge/types"

const greeterTool: AxonTool = {
    name: "greeter",
    fns: [{ name: "greet", declaration: "function greet(name: string): string" }],
    origin: "src",
    source: `
        export default {
            name: "greeter",
            exports: {
                greet: (name) => "hello " + name,
            },
        }
    `,
}

/**
 * A block whose calls were REFUSED is not a block that succeeded.
 *
 * `ok` meant "did the code throw", which is the wrong question for a denial —
 * nothing throws. A refused `process.spawn()` returns a handle; a refused tool
 * call returns a denial value. Neither propagates, so the kernel committed
 * `cognet:action:result` with `ok: true` and the durable record said a blocked
 * call had worked.
 *
 * Observed exactly that way in a real session:
 *
 *     seq 87  cognet:action:typescript   process.spawn("sleep 3600")
 *     seq 89  process:policy:denied      rule: "no-policy"
 *     seq 90  process:proc:denied        AX-CAPSULE-020
 *     seq 92  cognet:action:result       ok: TRUE
 *
 * The agent believed it held a background process, the timeline drew an
 * ordinary tool call, and the user's own policy had stopped it with nothing
 * anywhere saying so — a silent failure at the one boundary the policy system
 * exists to make visible.
 *
 * These assert the DURABLE RECORD, because that is what every surface reads
 * and what the bug was actually about.
 */
describe("kernel policy: a denied call fails its block", () => {
    it("commits ok:false when a tool call is denied", async () => {
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: false } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")
        expect(result).toBeDefined()
        expect((result!.data as { ok: boolean }).ok).toBe(false)

        await runtime.shutdown()
    }, 30_000)

    it("records WHICH call was refused and WHY, not merely that something was", async () => {
        // A rule spelling is actionable — "no rule permits it" means add one,
        // an explicit deny means remove one. "Denied by policy" tells a reader
        // nothing they can fix.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: false } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")
        const error = (result!.data as { error?: { kind: string; message: string } }).error
        expect(error?.kind).toBe("policy")
        expect(error?.message).toContain("greet")

        await runtime.shutdown()
    }, 30_000)

    it("the denial names the block it belongs to, so a surface can nest it", async () => {
        // The whole reason no UI ever rendered one: `process:policy:denied` was
        // durable and carried no commandId, so it was an orphan on the log with
        // no way to attach it to the Run(...) that provoked it.
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    policy: { tools: { greeter: false } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        const action = runtime.session.entries.find(e => e.type === "cognet:action:typescript")
        const denied = runtime.session.log.find(e => e.type === "process:policy:denied")
            ?? runtime.session.kernelLog.find(e => e.type === "process:policy:denied")

        expect(denied).toBeDefined()
        expect((denied!.data as { commandId: string | null }).commandId)
            .toBe((action!.data as { id: string }).id)

        await runtime.shutdown()
    }, 30_000)

    it("still commits ok:true when policy allows the call", async () => {
        // The fix must not turn every tool call into a failure — this is the
        // control that keeps `ok` meaningful.
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

        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")
        expect((result!.data as { ok: boolean }).ok).toBe(true)
        expect((result!.data as { content: string }).content).toBe("hello world")

        await runtime.shutdown()
    }, 30_000)
})

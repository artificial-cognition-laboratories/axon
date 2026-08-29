import { Axon as AxonRuntime } from "@arcforge/core"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { AxonEngineDriver, AxonEngineRawEvent, AxonTool } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"

/**
 * Tools loaded IN the agent's own process.
 *
 * The end state of the reshuffle: cognet, tools, scripts, routes and
 * model-emitted code share one heap, so `axon.tools.foo.bar()` from a script
 * is a function call. Today that same call is SYNTHESISED into a
 * `<typescript>` block, shipped over JSONL and eval'd in a subprocess — the
 * bridge in `runtime/source/tools.ts::callTool`, which exists solely because
 * of the boundary.
 *
 * What must NOT be lost with the boundary is mediation. These pin that: the
 * same policy decides, the same span events reach the log, and a denial is
 * still a typed error the model can reason about rather than a syscall failure
 * it cannot.
 */
const remote: () => AxonEngineDriver = () => ({
    async *stream(): AsyncGenerator<AxonEngineRawEvent> {
        yield {
            type: "done",
            response: {
                text: "<text>ok</text>",
                stopReason: "end",
                meta: { provider: "supervisor", model: "remote", durationMs: 1 },
            },
        }
    },
})

const greeter: AxonTool = {
    name: "greeter",
    origin: "src",
    fns: [{ name: "greet", declaration: "function greet(name: string): string" }],
    source: `export const greet = (name) => "hello " + name`,
} as AxonTool

const idle = defineCognet({
    name: "idle",
    version: "1.0.0",
    abi: KERNEL_ABI_VERSION,
    mode: { kind: "invocation" },
    async load() {},
    async wake() {},
})

function boot(over: { tools?: AxonTool[]; policy?: Record<string, unknown> } = {}) {
    return AxonRuntime({
        // `remote` is what puts this runtime on the confined path: inference
        // comes from outside, and tools load in this heap.
        remote,
        blueprint: {
            profileProviders: [],
            cognet: { name: "idle", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: idle },
            tools: over.tools ?? [greeter],
            ...(over.policy ? { config: { policy: over.policy } } : {}),
        },
    })
}

describe("tools — loaded in the agent's own process", () => {
    it("calls the real function and returns its result", async () => {
        const runtime = await boot()
        expect(await runtime.axon.tools.greeter.greet("world")).toBe("hello world")
        await runtime.shutdown()
    }, 20_000)

    it("is denied by policy exactly as a capsule call would be", async () => {
        // The boundary is gone; the gate is not. A tool the user denied must
        // still refuse, and refuse as a TYPED error the model can read.
        const runtime = await boot({ policy: { tools: { greeter: false } } })
        await expect(runtime.axon.tools.greeter.greet("world")).rejects.toThrow(/CAPSULE_POLICY_DENIED/)
        await runtime.shutdown()
    }, 20_000)

    it("records the denial in the log rather than only throwing", async () => {
        // This layer's remaining job after the OS wall takes over is audit.
        // A refusal nobody can see afterwards is a hole in that job.
        const runtime = await boot({ policy: { tools: { greeter: false } } })
        await runtime.axon.tools.greeter.greet("x").catch(() => {})

        const denied = runtime.session.kernelLog.filter(e => e.type === "process:policy:denied")
        expect(denied.length).toBeGreaterThan(0)
        await runtime.shutdown()
    }, 20_000)

    it("brackets a permitted call with fn:start and fn:complete", async () => {
        // Fleet folds its flame graph straight out of these, so the event
        // vocabulary has to survive the move unchanged.
        const runtime = await boot()
        await runtime.axon.tools.greeter.greet("world")

        const types = runtime.session.kernelLog.map(e => e.type)
        expect(types).toContain("process:fn:start")
        expect(types).toContain("process:fn:complete")
        await runtime.shutdown()
    }, 20_000)

    it("closes the bracket with fn:failed when a tool throws, and rethrows", async () => {
        const runtime = await boot({
            tools: [{
                name: "boom",
                origin: "src",
                fns: [{ name: "explode", declaration: "function explode(): void" }],
                source: `export const explode = () => { throw new Error("kaboom") }`,
            } as AxonTool],
        })

        await expect(runtime.axon.tools.boom.explode()).rejects.toThrow("kaboom")
        expect(runtime.session.kernelLog.map(e => e.type)).toContain("process:fn:failed")
        await runtime.shutdown()
    }, 20_000)

    it("round-trips an argument shaped to look like code", async () => {
        // The capsule path had to JSON-encode arguments into synthesised
        // source, so a value that looked like code could break out of its
        // slot. In-process there is no source to break out of — this pins
        // that the hazard is gone rather than merely unlikely.
        const runtime = await boot({
            tools: [{
                name: "echo",
                origin: "src",
                fns: [{ name: "say", declaration: "function say(v: string): string" }],
                source: `export const say = (v) => v`,
            } as AxonTool],
        })

        const hostile = `"); process.exit(1); ("`
        expect(await runtime.axon.tools.echo.say(hostile)).toBe(hostile)
        await runtime.shutdown()
    }, 20_000)

    it("fails loudly when a declared tool did not load", async () => {
        // The scope contract: what the model was TOLD it can call must be what
        // actually loaded. A silent undefined is the failure this seam exists
        // to prevent.
        await expect(boot({
            tools: [{
                name: "liar",
                origin: "src",
                fns: [{ name: "promised", declaration: "function promised(): void" }],
                source: `export const delivered = () => "surprise"`,
            } as AxonTool],
        })).rejects.toThrow(/declares \[promised\] but exports \[delivered\]/)
    }, 20_000)
})

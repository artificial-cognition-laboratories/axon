import { Tools } from "../../../src/tools"
import type { MediateOpts } from "../../../src/tools"
import type { AxonTool } from "@arcforge/types"

/**
 * The in-process tool manager — what replaces the capsule's split machinery
 * (a guest-side loader plus a host-side wire handshake) once the agent
 * boundary moves out to the whole process.
 *
 * These test BEHAVIOUR through the public surface: install a tool, call what
 * it exported, observe what policy and the span stream did. Nothing reaches
 * into the loader's internals — the same discipline the capsule's own suite
 * follows, and what makes these portable across the swap in the next commit.
 */

/** A mediation double that records every decision and span it was asked for. */
function recorder(verdict: (fn: string) => boolean = () => true) {
    const spans: string[] = []
    const checks: Array<{ fn: string; subject: string; owner: string }> = []
    const mediation: MediateOpts = {
        async check(fn, subject, _args, owner) {
            checks.push({ fn, subject, owner })
            return verdict(fn)
        },
        emit: {
            start: e => spans.push(`start:${e.fn}`),
            complete: e => spans.push(`complete:${e.fn}`),
            failed: e => spans.push(`failed:${e.fn}`),
        },
    }
    return { mediation, spans, checks }
}

function tool(over: Partial<AxonTool> & { name: string; source: string }): AxonTool {
    return {
        origin: "src",
        fns: [],
        ...over,
    } as AxonTool
}

const greeter = tool({
    name: "greeter",
    fns: [{ name: "greet", declaration: "function greet(name: string): string" }],
    source: `export const greet = (name) => "hello " + name`,
})

describe("Tools — loading and calling", () => {
    it("calls the real exported function and returns its result", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation })
        await tools.install([greeter])

        const globals = tools.globals() as { greet(n: string): Promise<string> }
        expect(await globals.greet("world")).toBe("hello world")
    })

    it("places a flat tool's exports as top-level names", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation })
        await tools.install([greeter])

        expect(Object.keys(tools.globals())).toEqual(["greet"])
    })

    it("places every export under its own name, whatever file it came from", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation })
        await tools.install([tool({
            name: "math",
            fns: [{ name: "add", declaration: "function add(a: number, b: number): number" }],
            source: `export const add = (a, b) => a + b`,
        })])

        // `add` is the EXPORT name; `math` is the file it came from. The
        // file groups, it does not namespace.
        const globals = tools.globals() as { add(a: number, b: number): Promise<number> }
        expect(await globals.add(2, 3)).toBe(5)
    })

    it("accepts the default-export authoring shape", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation })
        await tools.install([tool({
            name: "legacy",
            fns: [{ name: "ping", declaration: "function ping(): string" }],
            source: `export default { name: "legacy", exports: { ping: () => "pong" } }`,
        })])

        const globals = tools.globals() as { ping(): Promise<string> }
        expect(await globals.ping()).toBe("pong")
    })

    it("skips a tool with no loadable source or entry path", async () => {
        // Same predicate that builds the model's <scope>: declaring something
        // that cannot be called would tell the model to invoke a function that
        // does not exist.
        const { mediation } = recorder()
        const tools = Tools({ mediation })
        await tools.install([{ name: "ghost", origin: "src", fns: [] } as unknown as AxonTool])

        expect(tools.namespaces).toEqual([])
    })
})

describe("Tools — mediation", () => {
    it("checks policy before the function body runs", async () => {
        let ran = false
        ;(globalThis as Record<string, unknown>).__toolRan = () => { ran = true }

        const { mediation, checks } = recorder(() => false)
        const tools = Tools({ mediation })
        await tools.install([tool({
            name: "danger",
            fns: [{ name: "fire", declaration: "function fire(): void" }],
            source: `export const fire = () => { globalThis.__toolRan() }`,
        })])

        const globals = tools.globals() as { fire(): Promise<void> }
        await expect(globals.fire()).rejects.toThrow(/CAPSULE_POLICY_DENIED/)

        expect(ran).toBe(false)
        // The POLICY address — `<tool>.<export>` — not the flat call path.
        expect(checks[0]).toMatchObject({ fn: "danger.fire", owner: "danger" })
    })

    it("matches a glob rule against the first string argument", async () => {
        const { mediation, checks } = recorder()
        const tools = Tools({ mediation })
        await tools.install([greeter])

        await (tools.globals() as { greet(n: string): Promise<string> }).greet("world")
        expect(checks[0]?.subject).toBe("world")
    })

    it("opens the span only AFTER policy admits the call", async () => {
        // A denied call is a policy fact, not an execution that failed. Pairing
        // a :start with no end would leave an open bracket in every flame graph.
        const { mediation, spans } = recorder(() => false)
        const tools = Tools({ mediation })
        await tools.install([greeter])

        await expect((tools.globals() as { greet(n: string): Promise<string> }).greet("x")).rejects.toThrow()
        expect(spans).toEqual([])
    })

    it("brackets a successful call with start and complete", async () => {
        const { mediation, spans } = recorder()
        const tools = Tools({ mediation })
        await tools.install([greeter])

        await (tools.globals() as { greet(n: string): Promise<string> }).greet("x")
        expect(spans).toEqual(["start:greeter.greet", "complete:greeter.greet"])
    })

    it("closes the bracket with failed when the tool throws, and rethrows", async () => {
        const { mediation, spans } = recorder()
        const tools = Tools({ mediation })
        await tools.install([tool({
            name: "boom",
            fns: [{ name: "explode", declaration: "function explode(): void" }],
            source: `export const explode = () => { throw new Error("kaboom") }`,
        })])

        await expect((tools.globals() as { explode(): Promise<void> }).explode()).rejects.toThrow("kaboom")
        expect(spans).toEqual(["start:boom.explode", "failed:boom.explode"])
    })

    it("mediates NESTED members, not just the top level", async () => {
        // An object of objects: wrapping only the top level would leave
        // `api.inner.deep` unmediated while `api.shallow` was checked.
        const { mediation, checks } = recorder()
        const tools = Tools({ mediation })
        await tools.install([tool({
            name: "api",
            fns: [{ name: "inner", declaration: "const inner: { deep(): string }" }],
            source: `export const inner = { deep: () => "reached" }`,
        })])

        const globals = tools.globals() as { inner: { deep(): Promise<string> } }
        expect(await globals.inner.deep()).toBe("reached")
        expect(checks[0]?.fn).toBe("api.inner.deep")
    })
})

describe("Tools — a broken tool fails LOUDLY", () => {
    /**
     * The substantive behaviour change in this move.
     *
     * The capsule's loader caught every failure, emitted a
     * `process:tool:load:failed` event and returned normally; the host's build
     * listened for that event and rejected. Two halves of one decision joined
     * only by an event name crossing a wire. In one process that catch would
     * become a silent swallow — an agent running with a namespace the model has
     * been told it can call.
     */
    it("throws when a tool's source does not import", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation })

        await expect(tools.install([tool({
            name: "broken",
            fns: [{ name: "x", declaration: "function x(): void" }],
            source: `import { nothing } from "./does-not-exist"; export const x = nothing`,
        })])).rejects.toThrow(/"broken" failed to load/)
    })

    it("throws when exports do not match what the scope declared", async () => {
        // The model's <scope> and the editor's .d.ts both describe `declared`.
        // If the module exports something else, the model calls a function that
        // is not there — caught at boot rather than at call time.
        const { mediation } = recorder()
        const tools = Tools({ mediation })

        await expect(tools.install([tool({
            name: "liar",
            fns: [{ name: "promised", declaration: "function promised(): void" }],
            source: `export const delivered = () => "surprise"`,
        })])).rejects.toThrow(/declares \[promised\] but exports \[delivered\]/)
    })

    it("leaves nothing half-installed when a tool fails", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation })

        await expect(tools.install([
            greeter,
            tool({
                name: "liar",
                fns: [{ name: "promised", declaration: "function promised(): void" }],
                source: `export const delivered = () => "x"`,
            }),
        ])).rejects.toThrow()

        // The tool BEFORE the failure did load — install is sequential and
        // throws where it breaks. What must not happen is the broken one
        // appearing as though it worked.
        expect(tools.namespaces).not.toContain("liar")
    })
})

describe("Tools — reload", () => {
    it("drops a namespace the author deleted", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation })
        await tools.install([greeter])

        tools.remove("greeter")
        expect(tools.globals()).toEqual({})
    })

    it("clears everything for a rebuild", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation })
        await tools.install([greeter])

        tools.clear()
        expect(tools.namespaces).toEqual([])
    })
})

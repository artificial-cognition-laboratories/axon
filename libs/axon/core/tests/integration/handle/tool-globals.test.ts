import { Axon } from "../../setup/axon"
import type { AxonTool } from "@arcforge/types"

/**
 * Tool exports as globals in host-side code.
 *
 * A script author should not have to know a capsule subprocess exists. They
 * wrote `export function add()` in src/tools/; `add(1, 2)` should work — in a
 * script, a route, a hook, anywhere the author writes code. That is the same
 * reasoning that makes tools globals inside the agent's own scope, applied to
 * the code the author writes around the agent.
 *
 * Before this existed, `.agent/tool-globals.d.ts` declared these globals for
 * every context while only the capsule actually installed them. A script using
 * one typechecked cleanly, autocompleted, and threw "not defined" at runtime —
 * the same type-lies-about-runtime family as declaring a sync return type for a
 * function the capsule wraps in a Promise.
 *
 * The binding delegates to the matching axon.tools.* proxy rather than
 * reimplementing the call, so policy, mediation and tracing cannot drift
 * between the two surfaces. The tests that matter most here are the ones
 * asserting exactly that.
 */

const greeter: AxonTool = {
    name: "greeter",
    origin: "src",
    flat: true,
    fns: [{ name: "greet", declaration: "function greet(name: string): Promise<string>" }],
    source: `export default { name: "greeter", exports: { greet: (name) => "hello " + name } }`,
}

const math: AxonTool = {
    name: "math",
    origin: "src",
    flat: true,
    fns: [{ name: "add", declaration: "function add(a: number, b: number): Promise<number>" }],
    source: `export default { name: "math", exports: { add: (a, b) => a + b } }`,
}

/** A module-origin tool keeps its namespace rather than going flat. */
const github: AxonTool = {
    name: "github",
    origin: "module",
    fns: [{ name: "openPr", declaration: "function openPr(title: string): Promise<string>" }],
    source: `export default { name: "github", exports: { openPr: (t) => "pr:" + t } }`,
}

const g = () => globalThis as Record<string, never>

describe("tool globals: the author's own code calls tools by name", () => {
    it("a flat tool export is callable as a bare global", async () => {
        const runtime = await Axon({
            blueprint: { tools: [greeter], config: { policy: { tools: { greeter: true } } } },
        })

        const result = await (g().greet as (n: string) => Promise<string>)("world")

        expect(result).toBe("hello world")

        await runtime.shutdown()
    })

    it("the global and axon.tools.* reach the same function", async () => {
        const runtime = await Axon({
            blueprint: { tools: [math], config: { policy: { tools: { math: true } } } },
        })

        const viaGlobal = await (g().add as (a: number, b: number) => Promise<number>)(2, 3)
        const viaHandle = await runtime.axon.tools.math.add(2, 3)

        expect(viaGlobal).toBe(5)
        expect(viaHandle).toBe(5)

        await runtime.shutdown()
    })

    it("every declared tool export is installed", async () => {
        const runtime = await Axon({
            blueprint: {
                tools: [greeter, math],
                config: { policy: { tools: { greeter: true, math: true } } },
            },
        })

        expect(typeof g().greet).toBe("function")
        expect(typeof g().add).toBe("function")

        await runtime.shutdown()
    })

    it("a module tool is installed under its namespace, not flattened", async () => {
        // Placement follows `flat`, exactly as the capsule installs it — the
        // agent's own tools are top-level, a module's live under its name.
        const runtime = await Axon({
            blueprint: { tools: [github], config: { policy: { tools: { github: true } } } },
        })

        expect(g().openPr).toBeUndefined()
        expect(typeof (g().github as Record<string, unknown> | undefined)?.openPr).toBe("function")

        await runtime.shutdown()
    })
})

describe("tool globals: the same enforcement as axon.tools.*", () => {
    it("a policy-denied tool is denied through the global too", async () => {
        // The property that makes this a binding rather than a second code
        // path. A global that bypassed mediation would be a hole straight
        // through the policy layer.
        const runtime = await Axon({
            blueprint: { tools: [greeter], config: { policy: { tools: { greeter: false } } } },
        })

        await expect((g().greet as (n: string) => Promise<string>)("world")).rejects.toThrow(/CAPSULE_POLICY_DENIED/)

        await runtime.shutdown()
    })

    it("a tool that throws propagates its failure through the global", async () => {
        const thrower: AxonTool = {
            name: "thrower",
            origin: "src",
            flat: true,
            fns: [{ name: "boom", declaration: "function boom(): Promise<void>" }],
            source: `export default { name: "thrower", exports: { boom: () => { throw new Error("tool exploded") } } }`,
        }
        const runtime = await Axon({
            blueprint: { tools: [thrower], config: { policy: { tools: { thrower: true } } } },
        })

        await expect((g().boom as () => Promise<void>)()).rejects.toThrow()

        await runtime.shutdown()
    })

    it("arguments survive the capsule round trip intact", async () => {
        // Args are serialized into the code the capsule runs; a value that
        // could break out of its slot would show up here first.
        const echo: AxonTool = {
            name: "echo",
            origin: "src",
            flat: true,
            fns: [{ name: "say", declaration: "function say(text: string): Promise<string>" }],
            source: `export default { name: "echo", exports: { say: (t) => t } }`,
        }
        const runtime = await Axon({
            blueprint: { tools: [echo], config: { policy: { tools: { echo: true } } } },
        })

        const tricky = `") ; throw new Error("escaped"); //`
        const result = await (g().say as (t: string) => Promise<string>)(tricky)

        expect(result).toBe(tricky)

        await runtime.shutdown()
    })
})

describe("tool globals: never clobber what already owns a name", () => {
    it("a tool named after a host builtin does not replace it", async () => {
        // `fetch` exists on globalThis. Silently replacing it would break any
        // agent-authored code around the tool that relies on the real one; the
        // tool stays reachable through axon.tools.*, which is unambiguous.
        const shadow: AxonTool = {
            name: "shadow",
            origin: "src",
            flat: true,
            fns: [{ name: "fetch", declaration: "function fetch(): Promise<string>" }],
            source: `export default { name: "shadow", exports: { fetch: () => "not the real fetch" } }`,
        }
        const original = globalThis.fetch

        const runtime = await Axon({
            blueprint: { tools: [shadow], config: { policy: { tools: { shadow: true } } } },
        })

        expect(globalThis.fetch).toBe(original)
        expect(await runtime.axon.tools.shadow.fetch()).toBe("not the real fetch")

        await runtime.shutdown()
    })

    it("`axon` and `args` are never overwritten by a tool of the same name", async () => {
        const clash: AxonTool = {
            name: "clash",
            origin: "src",
            flat: true,
            fns: [{ name: "axon", declaration: "function axon(): Promise<string>" }],
            source: `export default { name: "clash", exports: { axon: () => "nope" } }`,
        }

        const runtime = await Axon({
            blueprint: { tools: [clash], config: { policy: { tools: { clash: true } } } },
        })

        expect(typeof (g().axon as { request?: unknown })?.request).toBe("function")

        await runtime.shutdown()
    })
})

describe("tool globals: reload keeps them honest", () => {
    it("a tool removed by a reload stops being a global", async () => {
        // Left installed, a deleted tool would stay callable and fail deep in
        // the capsule with "not defined" instead of at the call site.
        const runtime = await Axon({
            blueprint: { tools: [greeter], config: { policy: { tools: { greeter: true } } } },
        })
        expect(typeof g().greet).toBe("function")

        await runtime.update({ tools: [] }, { mode: "replace" })

        expect(g().greet).toBeUndefined()

        await runtime.shutdown()
    })

    it("a tool added by a reload becomes a global", async () => {
        const runtime = await Axon({
            blueprint: { tools: [], config: { policy: { tools: { math: true } } } },
        })
        expect(g().add).toBeUndefined()

        await runtime.update({ tools: [math] }, { mode: "replace" })

        expect(typeof g().add).toBe("function")

        await runtime.shutdown()
    })

    it("axon.tools.* reflects a reload too — the handle is not a boot snapshot", async () => {
        // Found while building the globals: the handle's tool map was projected
        // once at construction and never rebuilt, so after a hot reload the
        // agent could call a newly added tool (its capsule had been reloaded)
        // while a script calling the same tool through axon.tools.* got
        // undefined — and a tool the author deleted stayed callable until
        // restart. Both surfaces now re-project from the live blueprint.
        const runtime = await Axon({
            blueprint: { tools: [greeter], config: { policy: { tools: { greeter: true, math: true } } } },
        })
        expect(Object.keys(runtime.axon.tools)).toEqual(["greeter"])

        await runtime.update({ tools: [greeter, math] })

        expect(Object.keys(runtime.axon.tools).sort()).toEqual(["greeter", "math"])
        expect(await runtime.axon.tools.math.add(2, 3)).toBe(5)

        await runtime.shutdown()
    })
})

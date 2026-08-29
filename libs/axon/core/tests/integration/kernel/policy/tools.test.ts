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

describe("kernel policy: tools", () => {
    it("blueprint.tools reaches the real capsule — a loaded tool is callable when policy allows it", async () => {
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
    })

    it("a declared tool is allowed by default when the blueprint sets no policy.tools rule at all — Axon trusts its own declared blueprint, unlike the capsule's own deny-by-default", async () => {
        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                config: {
                    providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                    // no policy.tools entry for "greeter" at all — Axon defaults to allow
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")

        expect((result!.data as { ok: boolean }).ok).toBe(true)
        expect((result!.data as { content: string }).content).toBe("hello world")

        await runtime.shutdown()
    })

    it("an explicit policy.tools.<namespace>: false denies even a declared tool — the blueprint's own policy always wins over Axon's allow-by-default", async () => {
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

        expect((result!.data as { ok: boolean }).ok).toBe(false)

        await runtime.shutdown()
    })

    it("a policy change via update() reaches the reloaded capsule — allowed becomes denied", async () => {
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
        const before = runtime.session.entries.find(e => e.type === "cognet:action:result")
        expect((before!.data as { ok: boolean }).ok).toBe(false)

        await runtime.update({ config: { policy: { tools: { greeter: true } } } })

        await runtime.kernel.request({ content: "/go" })
        const results = runtime.session.entries.filter(e => e.type === "cognet:action:result")
        const after = results[results.length - 1]
        expect((after!.data as { ok: boolean }).ok).toBe(true)

        await runtime.shutdown()
    })

    it("a tool not declared in blueprint.tools is simply undefined in scope, not silently no-op'd", async () => {
        const runtime = await Axon({
            blueprint: {
                config: {
                    providers: [Mock({ "/go": [run(`nonexistent.doThing()`), "done"] })],
                    policy: { tools: { nonexistent: true } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        const result = runtime.session.entries.find(e => e.type === "cognet:action:result")

        expect((result!.data as { ok: boolean }).ok).toBe(false)
        expect((result!.data as { error?: { message: string } }).error?.message).toContain("not defined")

        await runtime.shutdown()
    })
})

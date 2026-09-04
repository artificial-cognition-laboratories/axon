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
 * A reload re-applies POLICY, in both directions.
 *
 * The ceiling tests next door prove policy reaches the capsule at BOOT. This
 * proves it is re-applied when the blueprint changes — the question nothing
 * asked, and the gap a real session fell into: a user tightened
 * `profile.config.ts` mid-session, the TUI reloaded, and the agent went on
 * spawning processes the new policy forbade.
 *
 * A stale policy is the worst possible failure mode for this subsystem. Every
 * surface renders the policy the user just wrote, so the system READS as
 * enforced while the capsule still runs the old one — the same "reads as
 * enforced while granting everything" the ceiling suite warns about, arriving
 * a second later through a door nobody was watching.
 *
 * BOTH directions are asserted deliberately. Tightening that does not apply is
 * a security hole; loosening that does not apply is an agent stuck refusing
 * work the user has already permitted, and only testing one leaves the other
 * free to break.
 */
describe("kernel reload: policy is re-applied", () => {
    async function ran(runtime: { session: { entries: Array<{ type: string; data: unknown }> } }, index: number): Promise<boolean> {
        const results = runtime.session.entries.filter(e => e.type === "cognet:action:result")
        return (results[index]?.data as { ok?: boolean } | undefined)?.ok === true
    }

    it("a tightened policy denies a call the old one allowed", async () => {
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
        expect(await ran(runtime, 0)).toBe(true)

        // What saving a stricter profile.config.ts amounts to.
        await runtime.update({
            tools: [greeterTool],
            config: {
                providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                policy: { tools: { greeter: false } },
            },
        })

        await runtime.kernel.request({ content: "/go" })
        expect(await ran(runtime, 1)).toBe(false)

        await runtime.shutdown()
    }, 60_000)

    it("a loosened policy allows a call the old one denied", async () => {
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
        expect(await ran(runtime, 0)).toBe(false)

        await runtime.update({
            tools: [greeterTool],
            config: {
                providers: [Mock({ "/go": [run(`greet("world")`), "done"] })],
                policy: { tools: { greeter: true } },
            },
        })

        await runtime.kernel.request({ content: "/go" })
        expect(await ran(runtime, 1)).toBe(true)

        await runtime.shutdown()
    }, 60_000)

    it("a tightened SHELL policy denies a spawn the old one allowed", async () => {
        // The exact shape of the reported bug: `shell.allow` commented out in
        // profile.config.ts mid-session, and the agent kept spawning.
        const runtime = await Axon({
            blueprint: {
                config: {
                    providers: [Mock({ "/go": [run(`process.spawn("sleep 30")`), "done"] })],
                    policy: { shell: { allow: ["*"], spawn: true } },
                },
            },
        })

        await runtime.kernel.request({ content: "/go" })
        expect(await ran(runtime, 0)).toBe(true)

        await runtime.update({
            config: {
                providers: [Mock({ "/go": [run(`process.spawn("sleep 30")`), "done"] })],
                policy: { shell: {} },
            },
        })

        await runtime.kernel.request({ content: "/go" })
        expect(await ran(runtime, 1)).toBe(false)

        await runtime.shutdown()
    }, 60_000)
})

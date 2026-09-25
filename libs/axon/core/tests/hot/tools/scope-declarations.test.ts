import { Tools } from "../../../src/tools"
import type { MediateOpts } from "../../../src/tools"
import { toScope } from "@arcforge/kernel"
import { renderScope, scopeToDts } from "@arcforge/air"
import type { AxonTool } from "@arcforge/types"

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "bun:test"

/**
 * Where these tools materialize. `scratch` is REQUIRED: the agent derives it
 * from its own frame rather than reading `os.tmpdir()`, which resolved
 * differently inside the agent process than on the host and stopped agents
 * booting on macOS entirely. Supplying a real directory is what the runtime does.
 */
const scratch = mkdtempSync(join(tmpdir(), "core-tools-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))


/**
 * The generated declarations describe what the runtime actually installs.
 *
 * This is the seam three separate places encode a decision about, and they
 * drifted: `scope-dts.ts` wrapped a module's members in
 * `namespace <tool name>`, while `Tools.globals()` spreads those members flat.
 * A tool file called `subagents.ts` exporting `const subagents = {…}` therefore
 * declared `subagents.subagents.request()` — a path an editor accepted, a model
 * read off the generated types and called, and the runtime did not have.
 *
 * ── Why this asserts paths and not the absence of a keyword ────────────────
 *
 * "Do not emit `namespace`" would pass while the two sides disagreed in the
 * other direction — the runtime namespacing and the types going flat is the
 * same bug wearing the other hat, and a keyword ban says nothing about it.
 * So the test walks every path the `.d.ts` declares and asserts it resolves
 * against a REAL loaded tool object. Any future divergence fails here,
 * whatever shape it takes.
 */

const mediation: MediateOpts = {
    async check() { return true },
    emit: { start() {}, complete() {}, failed() {} },
}

function tool(over: Partial<AxonTool> & { name: string; source: string }): AxonTool {
    return { origin: "src", fns: [], ...over } as AxonTool
}

/** Top-level names a generated `declare global { … }` block declares. */
function declaredNames(dts: string): string[] {
    const names = new Set<string>()
    for (const line of dts.split("\n")) {
        const trimmed = line.trim()
        // `const fs: {`, `function greet(...)`, `let x:` — the three forms a
        // member declaration can take inside an ambient block.
        const match = trimmed.match(/^(?:export\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/)
        if (match) names.add(match[1]!)
    }
    return [...names]
}

describe("generated declarations match the runtime scope", () => {
    it("declares a flat tool's exports as top-level globals", async () => {
        const tools = Tools({ mediation, scratch })
        const greeter = tool({
            name: "greeter",
            fns: [{ name: "greet", declaration: "function greet(name: string): string" }],
            source: `export const greet = (name) => "hello " + name`,
        })
        await tools.install([greeter])

        const dts = scopeToDts(toScope({ tools: [greeter] } as never))
        expect(declaredNames(dts)).toContain("greet")
        expect(Object.keys(tools.globals())).toContain("greet")
    })

    it("declares a MODULE tool exactly where the runtime puts it", async () => {
        // The regression. A module tool exporting one object named after its
        // own file is the common registry convention (@axon/subagent,
        // @axon/fs), and the namespace wrap turned it into `x.x.fn()`.
        const tools = Tools({ mediation, scratch })
        const subagents = tool({
            name: "subagents",
            origin: "module",
            fns: [{ name: "subagents", declaration: "const subagents: { request(p: string): Promise<string> }" }],
            source: `export const subagents = { request: async (p) => p }`,
        })
        await tools.install([subagents])

        const dts = scopeToDts(toScope({ tools: [subagents] } as never))
        const globals = tools.globals()

        // Every name the declarations promise exists on the real object...
        for (const name of declaredNames(dts)) {
            expect(globals).toHaveProperty(name)
        }
        // ...and the declared name lands on the OBJECT the runtime installed,
        // not one level above it. `subagents.request` is the callable path;
        // `subagents.subagents.request` was what the namespace wrap produced.
        expect(globals).toHaveProperty("subagents")
        expect((globals as { subagents: Record<string, unknown> }).subagents).toHaveProperty("request")
    })

    it("every declared name resolves on the loaded globals", async () => {
        // The general property, over a mixed set: an agent's own tools and an
        // installed module's, which take different placement branches.
        const tools = Tools({ mediation, scratch })
        const set = [
            tool({
                name: "greeter",
                fns: [{ name: "greet", declaration: "function greet(n: string): string" }],
                source: `export const greet = (n) => n`,
            }),
            tool({
                name: "fs",
                origin: "module",
                fns: [{ name: "fs", declaration: "const fs: { read(p: string): Promise<string> }" }],
                source: `export const fs = { read: async (p) => p }`,
            }),
        ]
        await tools.install(set)

        const globals = tools.globals()
        for (const name of declaredNames(scopeToDts(toScope({ tools: set } as never)))) {
            expect(globals).toHaveProperty(name)
        }
    })

    it("tells the MODEL the same paths the editor and runtime have", async () => {
        // Three renderings of one AxonScope: the model's <scope>, the editor's
        // .d.ts, and the actual globals. All three drifted once — the first two
        // wrapped a module's tools in a namespace the third did not have — so
        // a model called exactly what its own scope block promised and got
        // `undefined is not an object`.
        //
        // Asserted against the RUNTIME rather than against each other: two
        // renderers agreeing on a wrong answer is the failure that shipped.
        const tools = Tools({ mediation, scratch })
        const fsTool = tool({
            name: "fs",
            origin: "module",
            fns: [{ name: "fs", declaration: "const fs: { read(p: string): Promise<string> }" }],
            source: `export const fs = { read: async (p) => p }`,
        })
        await tools.install([fsTool])

        const scope = toScope({ tools: [fsTool] } as never)
        const globals = tools.globals()

        for (const name of declaredNames(renderScope(scope))) {
            expect(globals).toHaveProperty(name)
        }
        for (const name of declaredNames(scopeToDts(scope))) {
            expect(globals).toHaveProperty(name)
        }
    })

    it("reports a name two tools both claim", async () => {
        // What the namespace wrap was actually guarding. Resolving it by
        // renaming one caller's tool is the runtime deciding something only
        // the author can — so it is reported, and last-write-wins is stated
        // rather than silent.
        const clashes: Array<{ name: string; previous: string; next: string }> = []
        const tools = Tools({ mediation, scratch, onClash: entry => clashes.push(entry) })

        await tools.install([
            tool({
                name: "alpha",
                fns: [{ name: "read", declaration: "function read(): string" }],
                source: `export const read = () => "alpha"`,
            }),
            tool({
                name: "beta",
                fns: [{ name: "read", declaration: "function read(): string" }],
                source: `export const read = () => "beta"`,
            }),
        ])

        tools.globals()
        expect(clashes).toHaveLength(1)
        expect(clashes[0]).toMatchObject({ name: "read", previous: "alpha", next: "beta" })
    })

    it("reports a clash on the durable record, not just to a callback", async () => {
        // The seam existed and reached nobody, which is the same as silence:
        // a capability the author declared was simply absent, with nothing
        // saying which tool had taken the name. Asserted through the RUNTIME
        // rather than the callback, because a wired-up warning that never
        // reaches a log is the failure this closes.
        const { Axon } = await import("../../setup/axon")
        const mk = (name: string, exp: string) => ({
            name, origin: "src",
            fns: [{ name: exp, declaration: `function ${exp}(): string` }],
            source: `export const ${exp} = () => "${name}"`,
        })

        const runtime = await Axon({
            blueprint: {
                tools: [mk("alpha", "read"), mk("beta", "read")],
                config: { policy: { tools: { alpha: true, beta: true } } },
            },
        } as never)

        const warning = runtime.session.log.find(e => e.type === "build:warning")
        expect(warning).toBeDefined()
        const message = (warning!.data as { message: string }).message
        // Names BOTH sides and which one won — a warning that only says
        // "a clash occurred" leaves the reader to go and find it.
        expect(message).toContain("alpha")
        expect(message).toContain("beta")
        expect(message).toContain("read")

        await runtime.shutdown()
    }, 30_000)
})

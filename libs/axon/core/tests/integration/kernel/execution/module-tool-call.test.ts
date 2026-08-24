import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"
import { run } from "@arcforge/engines/mock"
import type { AxonTool } from "@arcforge/types"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A module-origin tool (source scanned from a module's own src/tools/*.ts,
 * one export per file, non-flat namespace collapse removed — see
 * scanModule() in platform/build/blueprint/modules/index.ts) must actually
 * be callable in the capsule, not just declared in the model's context.
 * The tool imports a sibling module, proving Capsule loads the authored file
 * in its package layout rather than materializing its source under /tmp.
 */
describe("kernel execution: module-origin tool calls", () => {
    it("loads a module tool from its real file so sibling relative imports resolve", async () => {
        const moduleRoot = await mkdtemp(join(tmpdir(), "axon-module-tool-"))
        const entryPath = join(moduleRoot, "src", "tools", "greeter.ts")
        await mkdir(join(moduleRoot, "src", "arxiv"), { recursive: true })
        await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
        await writeFile(join(moduleRoot, "src", "arxiv", "client.ts"), "export const hello = (name: string) => `hello ${name}`\n")
        await writeFile(entryPath, 'import { hello } from "../arxiv/client.ts"\nexport const greeter = { hello }\n')

        try {
            const moduleTool: AxonTool = {
                name: "greeter",
                origin: "module",
                modulePath: moduleRoot,
                entryPath,
                flat: true,
                fns: [{ name: "greeter", declaration: "const greeter: { hello(name: string): string }" }],
            }

            const runtime = await Axon({
                blueprint: {
                    config: { providers: [Mock({ "/go": [run(`greeter.hello("world")`), "done"] })] },
                    tools: [moduleTool],
                },
            })

            await runtime.kernel.request({ content: "/go" })

            const result = runtime.session.entries.find(e => e.type === "cognet:action:result")

            expect(result).toBeDefined()
            expect((result!.data as { ok: boolean }).ok).toBe(true)
            expect((result!.data as { content: string }).content).toBe("hello world")

            await runtime.shutdown()
        } finally {
            await rm(moduleRoot, { recursive: true, force: true })
        }
    })
})

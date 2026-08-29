import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { detectKind } from "@arcforge/platform/build/project"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

describe("bench platform topology", () => {
    it("opens a benchmark independently of project kind", async () => {
        const store = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const root = await mkdtemp(join(tmpdir(), "axon-test-bench-"))

        try {
            await Bun.write(join(root, "bench.config.ts"), "export default defineBench({ name: 'sample', version: '0.1.0', description: 'sample' })\n")
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })

            expect((await platform.projects.openAs("bench", root)).bench!.root).toBe(root)
            expect(platform.projects.find(join(root, "tests"))).toBe(root)
        } finally {
            await rm(store, { recursive: true, force: true })
            await rm(root, { recursive: true, force: true })
        }
    })

    it("a benchmark can live inside an agent without changing the agent's project kind", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-test-agent-bench-"))

        try {
            await Bun.write(join(root, "axon.config.ts"), "export default defineAgent({})\n")
            await Bun.write(join(root, "bench.config.ts"), "export default defineBench({ name: 'agent-eval', version: '0.1.0', description: 'agent eval' })\n")

            expect(detectKind(root)).toBe("agent")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("find walks from nested benchmark test files to their benchmark root", async () => {
        const store = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const root = await mkdtemp(join(tmpdir(), "axon-test-bench-"))
        const nested = join(root, "tests", "fixtures")

        try {
            await mkdir(nested, { recursive: true })
            await Bun.write(join(root, "bench.config.ts"), "export default defineBench({ name: 'nested', version: '0.1.0', description: 'nested' })\n")

            expect(Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store }).projects.find(nested)).toBe(root)
        } finally {
            await rm(store, { recursive: true, force: true })
            await rm(root, { recursive: true, force: true })
        }
    })
})

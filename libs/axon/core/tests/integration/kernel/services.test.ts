import { Axon as AxonRuntime } from "@arcforge/core"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { CognetUse, KernelAbi } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Services, end to end through a booted agent: a use the cognet declares,
 * filled by a provider the agent wrote, called from inside a wake through the
 * ABI — and recorded in the agent's session with the provider that answered.
 */

const FEATURES: CognetUse = {
    interface: "./interfaces/features@1",
    named: "@cody/terry/features@1",
    methods: { describe: { kind: "describe", params: [] }, extract: { kind: "call", params: ["picture", "patch"] } },
}

async function boot(services?: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), "axon-services-"))
    const filePath = path.join(root, "providers", "features.provider.ts")
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, `export default defineProvider({
    implements: "@cody/terry/features@1",
    describe: () => ({ patch: 16 }),
    async extract(picture, patch) { return { cells: picture.width / patch } },
})
`)
    const answers: unknown[] = []
    const captured: { abi?: KernelAbi } = {}
    const runtime = await AxonRuntime({
        blueprint: {
            cognet: {
                name: "probe",
                version: "1.0.0",
                abi: KERNEL_ABI_VERSION,
                uses: { features: FEATURES },
                definition: defineCognet({
                    name: "probe",
                    version: "1.0.0",
                    abi: KERNEL_ABI_VERSION,
                    mode: { kind: "invocation" },
                    load(abi) {
                        captured.abi = abi
                    },
                    async wake() {
                        answers.push(await captured.abi!.services.call("features", "extract", { picture: { width: 64 }, patch: 16 }))
                    },
                }),
            },
            config: services ? { services: services } : {},
            serviceProviders: [{ name: "./providers/features", filePath: filePath, implements: "@cody/terry/features@1", engines: {} }],
            knowledge: [],
            paths: { root: root, data: path.join(root, ".agent", "data") },
        },
    })
    return { runtime: runtime, abi: captured.abi!, answers: answers }
}

describe("services, through a booted agent", () => {
    test("a use is filled by the agent's own provider, called in a wake, and recorded with who answered", async () => {
        const { runtime, abi, answers } = await boot()
        expect(abi.services.state()).toEqual({ features: { available: true, describe: { patch: 16 } } })
        await runtime.axon.stim("cognet:stimulus:text", { channel: "test", content: "look" })
        await Bun.sleep(200)
        expect(answers).toEqual([{ cells: 4 }])
        const recorded = runtime.session.kernelLog.filter(event => event.type.startsWith("kernel:service:"))
        expect(recorded.map(event => event.type)).toEqual(["kernel:service:start", "kernel:service:complete"])
        expect(recorded[0]!.data).toMatchObject({ use: "features", method: "extract", kind: "call", provider: "./providers/features" })
        await runtime.shutdown()
    })

    test("a required use granted off stops the boot, by name", async () => {
        await expect(boot({ features: "off" })).rejects.toThrow(/features \(@cody\/terry\/features@1\) — granted off/)
    })
})

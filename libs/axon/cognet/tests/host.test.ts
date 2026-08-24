import type { KernelAbi } from "@arcforge/types"
import { CognetHost } from "../src/host"

describe("CognetHost lifecycle", () => {
    it("executes and registers a hash-busted artifact only once when load is repeated", async () => {
        let executions = 0
        const host = CognetHost(
            { name: "reloadable", version: "1.0.0", abi: "4" },
            async () => {
                executions++
                ;(globalThis as unknown as { loop(body: () => Promise<void>): void }).loop(async () => {})
            },
        )
        const abi = {} as KernelAbi

        await host.load(abi)
        await host.load(abi)

        expect(executions).toBe(1)
        await host.unload?.()
    })

    it("rejects rebinding a loaded artifact to a different syscall table", async () => {
        const host = CognetHost(
            { name: "reloadable", version: "1.0.0", abi: "4" },
            async () => {
                ;(globalThis as unknown as { loop(body: () => Promise<void>): void }).loop(async () => {})
            },
        )

        await host.load({} as KernelAbi)
        await expect(host.load({} as KernelAbi)).rejects.toMatchObject({ code: "AX-COGNET-003" })
        await host.unload?.()
    })
})

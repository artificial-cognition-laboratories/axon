import type { KernelAbi } from "@arcforge/types"
import { CognetHost } from "../src/host"

describe("CognetHost lifecycle", () => {
    it("executes and registers a hash-busted artifact only once when load is repeated", async () => {
        let executions = 0
        const host = CognetHost(
            { name: "reloadable", version: "1.0.0", abi: "4", mode: { kind: "invocation" } },
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
            { name: "reloadable", version: "1.0.0", abi: "4", mode: { kind: "invocation" } },
            async () => {
                ;(globalThis as unknown as { loop(body: () => Promise<void>): void }).loop(async () => {})
            },
        )

        await host.load({} as KernelAbi)
        await expect(host.load({} as KernelAbi)).rejects.toMatchObject({ code: "AX-COGNET-003" })
        await host.unload?.()
    })

    it("delegates the ambient kernel.knowledge surface to the bound syscall table", async () => {
        // The ambient globals are what a cognet author actually writes
        // against. A verb present on KernelAbi but never wired through the
        // host is undefined at authoring time and typechecks anyway — this
        // is the only place that gap is visible.
        const calls: string[] = []
        const abi = {
            // The wake machinery narrates its own clock through emit, so a
            // stub that omits it never reaches the loop body.
            emit: () => {},
            knowledge: {
                list: async () => { calls.push("list"); return [] },
                read: async () => { calls.push("read"); return "body" },
                write: async () => { calls.push("write") },
                remove: async () => { calls.push("remove") },
            },
        } as unknown as KernelAbi

        // Called from inside the loop body, which is where a cognet reaches
        // for it — the ambient facade resolves the wake's async scope, so a
        // call outside one correctly throws.
        let read: string | null = null
        const host = CognetHost({ name: "knower", version: "1.0.0", abi: "4", mode: { kind: "invocation" } }, async () => {
            const g = globalThis as unknown as { loop(body: (ctx: { stop(): void }) => Promise<void>): void; kernel: KernelAbi }
            g.loop(async ({ stop }) => {
                read = await g.kernel.knowledge.read("notes.md")
                await g.kernel.knowledge.list()
                await g.kernel.knowledge.write("notes.md", "content")
                await g.kernel.knowledge.remove("notes.md")
                stop()
            })
        })
        await host.load(abi)
        await host.wake({ stimuli: [], signal: new AbortController().signal })

        expect(read).toBe("body")
        expect(calls).toEqual(["read", "list", "write", "remove"])
        await host.unload?.()
    })
})

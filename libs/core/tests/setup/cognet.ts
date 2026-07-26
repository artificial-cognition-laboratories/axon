import type { KernelAbi } from "@arcforge/types"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { defineCognet, Ecs } from "../../src/cognet"
import { Air } from "../../src/platform/air"

/**
 * Minimal complete brain used by core integration tests — ABI 8.
 *
 * Mirrors the real cognet loop shape closely enough to exercise the kernel
 * end to end: build a prompt from base/scope/session history, stream the
 * engine, commit text/typescript blocks via output(), run pending code via
 * run() (which self-commits cognet:action:typescript/cognet:action:result), stop on
 * engine:stop with nothing left pending.
 */
export function TestCognet() {
    const air = Air()
    let kernel: KernelAbi | null = null

    function syscalls(): KernelAbi {
        if (!kernel) throw new Error("test cognet: wake before load(abi)")
        return kernel
    }

    return defineCognet({
        name: "test",
        version: "1.0.0",
        abi: KERNEL_ABI_VERSION,
        mode: { kind: "invocation" },

        load(abi) {
            kernel = abi
        },

        async wake({ signal }) {
            const abi = syscalls()
            const ecs = Ecs({ emit: abi.emit })
            let stopped = false

            while (!stopped && !signal.aborted) {
                if (ecs.state.tick >= 8) {
                    const error = new Error("COGNET_MAX_TICKS: test exceeded 8 ticks in one wake") as Error & { code: string }
                    error.code = "COGNET_MAX_TICKS"
                    throw error
                }
                await ecs.tick(async () => {
                    const messages = await ecs.phase("build", async () => {
                        const base = await abi.base()
                        return air.render({
                            ...(base ? { base } : {}),
                            scope: abi.scope(),
                            history: abi.store.session.get(),
                        })
                    })

                    let stopRequested = false
                    const executes = await ecs.phase("invoke", async () => {
                        const pending: Array<{ id: string; code: string }> = []

                        for await (const event of abi.stream({ messages, signal })) {
                            switch (event.type) {
                                case "engine:text:delta":
                                    break
                                case "engine:text":
                                    await abi.output("cognet:output:text", { content: event.content })
                                    break
                                case "engine:typescript":
                                    pending.push({ id: event.id, code: event.content })
                                    break
                                case "engine:output:error":
                                    // the model broke the AIR contract — surface it as an ordinary
                                    // fact so next tick's render shows the model its own violation
                                    await abi.output("cognet:output:text", {
                                        content: `[format] ${event.code}: ${event.message}`,
                                    })
                                    break
                                case "engine:stop":
                                    stopRequested = true
                                    break
                                case "engine:done":
                                    break
                            }
                        }

                        return pending
                    })

                    await ecs.phase("act", async () => {
                        if (executes.length === 0) return
                        const results = await abi.run(executes.map(ex => ex.code), { signal })
                        void results // self-committed by the kernel's run() — nothing left for the cognet to do
                    })

                    if (stopRequested && executes.length === 0) stopped = true
                })
            }
        },
    })
}

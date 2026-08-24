import type { KernelAbi } from "@arcforge/types"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"
import { Clock } from "@arcforge/cognet"
import { Air } from "@arcforge/air"

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

        // One cortex role, matching what a real invocation cognet declares.
        // Deliberately unconstrained beyond its shape: a test asserts kernel
        // behaviour, and a context floor here would make every fixture pass
        // or fail on the resolver's arithmetic instead.
        engines: {
            main: { type: "generate", in: "text", out: "text", primary: true },
        },

        load(abi) {
            kernel = abi
        },

        async wake({ signal }) {
            const abi = syscalls()
            const clock = Clock({ emit: abi.emit })
            let stopped = false

            while (!stopped && !signal.aborted) {
                if (clock.tick >= 8) {
                    const error = new Error("COGNET_MAX_TICKS: test exceeded 8 ticks in one wake") as Error & { code: string }
                    error.code = "COGNET_MAX_TICKS"
                    throw error
                }
                await clock.runTick(async () => {
                    // Named so a retry can call it again: the kernel commits
                    // the rejected reply and its correction as entries, then
                    // re-renders through this so the next attempt reads one
                    // well-formed document rather than a finished document
                    // with a correction stapled on after `</timeline>`.
                    const render = async () => {
                        const base = await abi.base()
                        return air.render({
                            ...(base ? { base } : {}),
                            scope: abi.scope(),
                            history: abi.store.session.get(),
                        })
                    }

                    const messages = await clock.runPhase("build", render)

                    // The kernel ran the scripts and interpolated the text.
                    // What is left here is the only cognitive part: deciding
                    // that THIS engine's text is what the agent says, and
                    // whether the turn is over.
                    const done = await clock.runPhase("invoke", async () => {
                        let finished = false

                        for await (const event of abi.engine("main").stream({ messages, rerender: render })) {
                            switch (event.type) {
                                case "engine:text":
                                    await abi.output("cognet:output:text", {
                                        channel: "reply",
                                        content: event.content,
                                        chunk: event.chunk,
                                    })
                                    break
                                case "engine:script":
                                    // Running it is the BRAIN's act. The
                                    // kernel parsed and reported; whether this
                                    // code runs is cognition's call.
                                    await abi.run(event.content)
                                    break
                                case "engine:done":
                                    finished = event.yielded && !event.acted
                                    break
                            }
                        }

                        return finished
                    })

                    if (done) stopped = true
                })
            }
        },
    })
}

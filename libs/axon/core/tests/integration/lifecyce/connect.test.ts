import { Axon as AxonRuntime } from "@arcforge/core"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { KernelAbi } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"

/**
 * Talking to a continuous mind.
 *
 * A continuous mind has no request lifecycle: its own clock runs it, and
 * `stream()` refuses it outright. A client connects instead — says things,
 * and hears what the mind says back, as and when it says it. This proves the
 * line end to end: what a client sends reaches the mind's wake, and the
 * client hears what is addressed to it, or to no one, and not what is
 * addressed to another client.
 */

/** A continuous mind that answers every text it hears on three channels: back to the sender, to no one, and to someone else. */
function EchoCognet() {
    let kernel: KernelAbi | null = null
    let clock: ReturnType<typeof setInterval> | null = null

    return defineCognet({
        name: "echo",
        version: "1.0.0",
        abi: KERNEL_ABI_VERSION,
        mode: { kind: "continuous", hz: 100 },
        load(abi) {
            kernel = abi
            clock = setInterval(() => void kernel!.wake(), 10)
        },
        async wake({ stimuli }) {
            for (const stimulus of stimuli) {
                if (stimulus.type !== "cognet:stimulus:text") continue
                const heard = stimulus.data.content
                kernel!.emit("cognet:activity", { working: ["echo"] })
                await kernel!.output("cognet:output:text", { channel: stimulus.data.channel, content: `you said ${heard}` })
                await kernel!.output("cognet:output:text", { channel: "", content: `everyone: ${heard}` })
                await kernel!.output("cognet:output:text", { channel: "telegram:1", content: `not yours: ${heard}` })
                kernel!.emit("cognet:activity", { working: [] })
                // A mind of systems says this for itself; a hand-written one, as here, must.
                kernel!.emit("cognet:settled", { seqs: [stimulus.time.seq] })
            }
        },
        async unload() {
            if (clock) clearInterval(clock)
            clock = null
        },
    })
}

describe("connect", () => {
    it("sends to a continuous mind, and hears what it says to this client or to no one", async () => {
        const runtime = await AxonRuntime({
            blueprint: { cognet: { name: "echo", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: EchoCognet() } },
        })
        try {
            const terminal = runtime.axon.connect({ channel: "terminal" })
            const heard: string[] = []
            const activity: string[][] = []
            terminal.on("cognet:output:text", data => { heard.push(data.content) })
            terminal.activity(working => { activity.push(working) })

            await terminal.send("hello")
            for (let waited = 0; (heard.length < 2 || activity.length < 2) && waited < 2_000; waited += 10) await Bun.sleep(10)

            expect(heard).toEqual(["you said hello", "everyone: hello"])
            expect(activity).toEqual([["echo"], []])
        } finally {
            await runtime.shutdown()
        }
    })

    it("answers a request to a continuous mind: what it says to the asker or to no one, ending when it has settled the message", async () => {
        const runtime = await AxonRuntime({
            blueprint: { cognet: { name: "echo", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: EchoCognet() } },
        })
        try {
            const result = await runtime.axon.request({ prompt: "hello", channel: "terminal" })
            expect(result.text).toBe("you said hello\neveryone: hello")
        } finally {
            await runtime.shutdown()
        }
    })
})

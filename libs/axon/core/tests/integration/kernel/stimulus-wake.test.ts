import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

/**
 * The stimulus trigger — a wake caused by the WORLD rather than by a caller.
 *
 * This is what makes a sense organ (a channel module, a sensor) work: it has
 * no caller by definition, so before this existed a stimulus it delivered
 * queued in the log and the agent never thought about it.
 *
 * Everything here goes through axon.stim() and reads session.entries — the
 * same two doors a real body uses.
 */
describe("kernel scheduling: waking on a stimulus", () => {
    /** Stimulus → wake is asynchronous and detached; give it room to land. */
    async function settle(): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 200))
    }

    it("a stimulus with no caller wakes the agent and produces a reply", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } },
        })

        await runtime.axon.stim("cognet:stimulus:text", {
            channel: "telegram:1",
            content: "hello",
        })
        await settle()

        const reply = runtime.session.entries.find(e => e.type === "cognet:output:text")
        expect((reply?.data as { content: string } | undefined)?.content).toBe("Hi there!")

        await runtime.shutdown()
    })

    it("does not wake on the agent's own output — no runaway echo", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } },
        })

        await runtime.axon.stim("cognet:stimulus:text", {
            channel: "telegram:1",
            content: "hello",
        })
        await settle()
        await settle()

        // One stimulus in, one reply out. A brain waking on its own echo
        // would keep going, so this count is the loop guard's proof.
        const replies = runtime.session.entries.filter(e => e.type === "cognet:output:text")
        expect(replies.length).toBe(1)

        await runtime.shutdown()
    })

    it("stimuli arriving together are answered, not dropped", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } },
        })

        await runtime.axon.stim("cognet:stimulus:text", { channel: "telegram:1", content: "hello" })
        await runtime.axon.stim("cognet:stimulus:text", { channel: "telegram:2", content: "hello" })
        await settle()

        // Both are committed; the second is either its own wake or drained by
        // the first's — either way the sensation is never lost.
        const stimuli = runtime.session.entries.filter(e => e.type === "cognet:stimulus:text")
        expect(stimuli.length).toBe(2)

        const replies = runtime.session.entries.filter(e => e.type === "cognet:output:text")
        expect(replies.length).toBeGreaterThanOrEqual(1)

        await runtime.shutdown()
    })

    it("request() still works — the caller path is unchanged", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "Hi there!" })] } },
        })

        const result = await runtime.axon.request("hello")
        expect(result.text).toBe("Hi there!")

        await runtime.shutdown()
    })
})

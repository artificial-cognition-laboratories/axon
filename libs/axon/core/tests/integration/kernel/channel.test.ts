import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

/**
 * The channel names the SURFACE a message arrived on, and is the address a
 * reply goes back to.
 *
 * It was hardcoded `"user"`, which answered the wrong question: every other
 * value (`telegram:8199`, `discord:…`) names a line rather than a person, and
 * the rendered turn already says `from="user"` — so it read
 * `<text from="user" channel="user">`, the same fact twice, with no way for a
 * second surface to identify itself.
 */
describe("kernel: the channel is the surface", () => {
    it("defaults to terminal when the caller names none", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hi: "hello" })] } } })
        await runtime.axon.request("hi")

        const stimulus = runtime.session.entries.find(e => e.type === "cognet:stimulus:text")
        expect((stimulus!.data as { channel: string }).channel).toBe("terminal")

        await runtime.shutdown()
    }, 30_000)

    it("carries the surface the host declared", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hi: "hello" })] } } })
        await runtime.axon.request({ prompt: "hi", channel: "axon-cli" })

        const stimulus = runtime.session.entries.find(e => e.type === "cognet:stimulus:text")
        expect((stimulus!.data as { channel: string }).channel).toBe("axon-cli")

        await runtime.shutdown()
    }, 30_000)

    it("renders the surface onto the turn, so a reply can be addressed", async () => {
        let seen = ""
        const runtime = await Axon({
            blueprint: {
                config: {
                    providers: [Mock(req => {
                        seen = req.messages.map(m => m.content).join("\n")
                        return "ok"
                    })],
                },
            },
        })
        await runtime.axon.request({ prompt: "yo", channel: "telegram:8199237521" })

        expect(seen).toContain(`channel="telegram:8199237521"`)
        // And never the old value, which said nothing the tag did not.
        expect(seen).not.toContain(`channel="user"`)

        await runtime.shutdown()
    }, 30_000)
})

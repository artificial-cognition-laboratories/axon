import { describe, it, expect } from "bun:test"
import { Mock, air, isFollowUpTick } from "@axon/engines"

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_IDS = {
    userId: "276035985668702210",
    channelId: "1513228410942390292",
    guildId: "1467099910724780054",
}

/** Fire a Discord message through the hook and collect the reply. */
async function sendMessage(axon: any, content: string): Promise<string | null> {
    let replied: string | null = null
    await axon.hooks.callHook("discord:message.received", {
        content,
        username: "cody",
        ...TEST_IDS,
        reply: async (text: string) => { replied = text },
    })
    return replied
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("discord module", () => {

    it("boots barry with the discord module loaded", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        expect(axon).toBeDefined()
        expect(axon.tools.discord).toBeDefined()
        await stop()
    })

    it("exposes the expected tool namespaces", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        expect(typeof axon.tools.discord.play).toBe("function")
        expect(typeof axon.tools.discord.skip).toBe("function")
        expect(typeof axon.tools.discord.stop).toBe("function")
        expect(typeof axon.tools.discord.pause).toBe("function")
        expect(typeof axon.tools.discord.resume).toBe("function")
        expect(typeof axon.tools.discord.queue).toBe("function")
        expect(typeof axon.tools.discord.history).toBe("function")
        expect(typeof axon.tools.discord.members).toBe("function")
        expect(typeof axon.tools.discord.channels).toBe("function")
        await stop()
    })

    it("renders the discord prompt with required props", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        const prompt = await axon.prompt("discord", {
            content: "hello",
            username: "cody",
            ...TEST_IDS,
            thread: [],
            nowPlaying: { current: null, upcoming: [] },
        })
        expect(prompt.content).toContain("cody")
        expect(prompt.content).toContain("hello")
        await stop()
    })

    it("discord prompt includes thread history when provided", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        const prompt = await axon.prompt("discord", {
            content: "what did we talk about?",
            username: "cody",
            ...TEST_IDS,
            thread: [
                { username: "cody", content: "hey barry", timestamp: new Date().toISOString() },
                { username: "axon", content: "hey cody", timestamp: new Date().toISOString() },
            ],
            nowPlaying: { current: null, upcoming: [] },
        })
        expect(prompt.content).toContain("hey barry")
        expect(prompt.content).toContain("hey cody")
        await stop()
    })

    it("discord prompt surfaces now-playing state when music is active", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        const prompt = await axon.prompt("discord", {
            content: "whats playing?",
            username: "cody",
            ...TEST_IDS,
            thread: [],
            nowPlaying: { current: "Never Gonna Give You Up", upcoming: ["Bohemian Rhapsody"] },
        })
        expect(prompt.content).toContain("Never Gonna Give You Up")
        expect(prompt.content).toContain("Bohemian Rhapsody")
        await stop()
    })

    it("fires a reply when a message hook is triggered", async () => {
        const { axon, stop } = await Axon({
            config: { engine: Mock(() => air.text("hey cody")) },
        })
        const reply = await sendMessage(axon, "hello barry")
        expect(reply).toBe("hey cody")
        await stop()
    })

    it("agent calls play tool when asked to play music", async () => {
        const { axon, stop } = await Axon({
            config: {
                engine: Mock((req) => {
                    // First tick: execute the play tool. Follow-up tick: reply with result.
                    if (isFollowUpTick(req)) return air.text("Now playing something great.")
                    return air.typescript(`discord.play("something", "${TEST_IDS.userId}", "${TEST_IDS.guildId}")`)
                }),
            },
        })
        const reply = await sendMessage(axon, "play some music")
        // play() throws in test env (no Discord client) — agent still replies from tool error
        expect(reply).toBeTruthy()
        await stop()
    })

    it("queue returns empty state when nothing is playing", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        const state = await axon.tools.discord.queue(TEST_IDS.guildId)
        expect(state).toEqual({ current: null, upcoming: [] })
        await stop()
    })

    it("skip returns not-playing message when queue is empty", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        const result = await axon.tools.discord.skip(TEST_IDS.guildId)
        expect(result).toBe("Nothing is playing.")
        await stop()
    })

    it("stop returns not-playing message when queue is empty", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        const result = await axon.tools.discord.stop(TEST_IDS.guildId)
        expect(result).toBe("Nothing is playing.")
        await stop()
    })

    it("pause returns not-playing message when nothing is active", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        const result = await axon.tools.discord.pause(TEST_IDS.guildId)
        expect(result).toBe("Nothing is playing.")
        await stop()
    })

    it("resume returns not-paused message when nothing is active", async () => {
        const { axon, stop } = await Axon({ config: { engine: Mock() } })
        const result = await axon.tools.discord.resume(TEST_IDS.guildId)
        expect(result).toBe("Nothing is paused.")
        await stop()
    })
})

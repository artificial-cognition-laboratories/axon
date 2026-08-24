import { REST, Routes, ChannelType } from "discord.js"
import type {
    APIMessage,
    RESTGetAPIChannelMessagesResult,
    RESTGetAPIGuildChannelsResult,
} from "discord.js"

/**
 * The Discord tool surface — everything the agent can call. Only `discord` is
 * exported: any export from a tools/ file becomes an agent-callable namespace,
 * so the REST client is a private local, not part of the surface.
 *
 * Tools run in the capsule sandbox and use REST only — no gateway connection.
 * Receiving messages is the gateway's job and lives in the module's setup(),
 * which runs in the agent runtime, not here.
 */

let _rest: REST | null = null

/** A logged-in REST client, initialised once. Reads DISCORD_BOT_TOKEN from the capsule env. */
function getRest(): REST {
    if (_rest) return _rest
    const token = process.env.DISCORD_BOT_TOKEN
    if (!token) throw new Error("DISCORD_BOT_TOKEN is not set in the capsule environment.")
    _rest = new REST({ version: "10" }).setToken(token)
    return _rest
}

export const discord = {
    /**
     * Fetch recent messages from a text channel, oldest-first, up to 50.
     * @param channelId - Discord channel ID
     * @param limit - Number of messages to fetch (default 20, max 50)
     */
    async history(
        channelId: string,
        limit: number = 20,
    ): Promise<Array<{ username: string; content: string; timestamp: string }>> {
        const messages = (await getRest().get(Routes.channelMessages(channelId), {
            query: new URLSearchParams({ limit: String(Math.min(limit, 50)) }),
        })) as RESTGetAPIChannelMessagesResult

        // The REST API returns newest-first — reverse to oldest-first.
        return [...messages].reverse().map((m: APIMessage) => ({
            username: m.author.username,
            content: m.content,
            timestamp: new Date(m.timestamp).toISOString(),
        }))
    },

    /**
     * List all text channels in a server.
     * @param guildId - Discord server (guild) ID
     */
    async channels(guildId: string): Promise<Array<{ id: string; name: string }>> {
        const all = (await getRest().get(Routes.guildChannels(guildId))) as RESTGetAPIGuildChannelsResult
        return all
            .filter(c => c.type === ChannelType.GuildText)
            .map(c => ({ id: c.id, name: c.name ?? "" }))
    },

    /**
     * Send a message to a Discord channel — the agent's mouth.
     *
     * `channel` is the address from the stimulus being answered —
     * `"discord:123456789"` — or a bare channel id. There is deliberately no
     * "reply to the last message": that is a hidden global that misroutes the
     * moment two people write at once. The mind reads the channel off the
     * message it is answering and passes it here.
     *
     * Returns a receipt. A send is a WRITE the agent is waiting on, so it has
     * to come back as evidence it happened — returning void reads as failure
     * in the capsule result, and an agent that believes its reply failed sends
     * it again.
     *
     * @param channel - Channel address from the stimulus, e.g. "discord:123456789"
     * @param text - Message content
     *
     * @example
     * await discord.send(channel, "Deploy finished — all green.")
     */
    async send(channel: string, text: string): Promise<{ ok: true; channel: string; messageId: string }> {
        const channelId = toChannelId(channel)
        const message = (await getRest().post(Routes.channelMessages(channelId), {
            body: { content: text },
        })) as APIMessage
        return { ok: true, channel, messageId: message.id }
    },
}

/**
 * Accept either the channel form (`"discord:123456789"`) or a bare id.
 *
 * Throws on anything else rather than passing it through: Discord answers an
 * unknown channel with "Unknown Channel", which reads like the channel was
 * deleted and hides the real fault — a malformed address.
 */
function toChannelId(channel: string): string {
    const raw = channel.startsWith("discord:") ? channel.slice("discord:".length) : channel
    if (!/^\d+$/.test(raw)) {
        throw new Error(
            `Invalid Discord channel "${channel}" — expected "discord:<channelId>" or a numeric channel id. ` +
            `Use the channel from the stimulus you are replying to.`,
        )
    }
    return raw
}

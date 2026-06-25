import { ChannelType, type TextChannel, type Guild } from "discord.js"
import { getClient } from "./client"

/**
 * Fetch recent messages from a text channel.
 * Returns messages oldest-first, up to 50.
 * @param channelId - Discord channel ID
 * @param limit - Number of messages to fetch (default 20, max 50)
 */
export async function history(
    channelId: string,
    limit: number = 20,
): Promise<Array<{ username: string; content: string; timestamp: string }>> {
    const client = await getClient()
    const channel = client.channels.cache.get(channelId)
    if (!channel || channel.type !== ChannelType.GuildText)
        throw new Error("Text channel not found.")
    const messages = await (channel as TextChannel).messages.fetch({ limit: Math.min(limit, 50) })
    return [...messages.values()].reverse().map(m => ({
        username: m.author.username,
        content: m.content,
        timestamp: m.createdAt.toISOString(),
    }))
}

/**
 * List currently online members in a server, including their voice channel if any.
 * Excludes bots and offline members.
 * @param guildId - Discord server (guild) ID
 */
export async function members(
    guildId: string,
): Promise<Array<{ username: string; status: string; voiceChannel: string | null }>> {
    const client = await getClient()
    const guild = client.guilds.cache.get(guildId) as Guild | undefined
    if (!guild) throw new Error("Guild not found.")
    await guild.members.fetch()
    return [...guild.members.cache.values()]
        .filter(m => !m.user.bot && m.presence?.status && m.presence.status !== "offline")
        .map(m => ({
            username: m.user.username,
            status: m.presence?.status ?? "unknown",
            voiceChannel: m.voice.channel?.name ?? null,
        }))
}

/**
 * List all text channels in a server.
 * @param guildId - Discord server (guild) ID
 */
export async function channels(guildId: string): Promise<Array<{ id: string; name: string }>> {
    const client = await getClient()
    const guild = client.guilds.cache.get(guildId) as Guild | undefined
    if (!guild) throw new Error("Guild not found.")
    return [...guild.channels.cache.values()]
        .filter(c => c.type === ChannelType.GuildText)
        .map(c => ({ id: c.id, name: c.name }))
}

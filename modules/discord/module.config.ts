import {
    Client,
    GatewayIntentBits,
    Events,
    type Message,
} from "discord.js"

// Hoisted for DiscordOptions type export — must match the inline options below.
const _optionsSchema = {
    guildId:     { type: "string"  as const, required: false as const },
    channelIds:  { type: "string"  as const, required: false as const },
    mentionOnly: { type: "boolean" as const, required: false as const },
    prefix:      { type: "string"  as const, required: false as const },
} as const

export type DiscordOptions = {
    [K in keyof typeof _optionsSchema]?: K extends "guildId" ? string
        : K extends "channelIds" ? string
        : K extends "mentionOnly" ? boolean
        : K extends "prefix" ? string
        : never
}

export default defineModule({
    name: "discord",
    description: "Discord bot integration — messages, music, and channel info.",
    public: true,

    env: {
        DISCORD_BOT_TOKEN: {
            required: true,
            description: "Discord bot token from the Discord developer portal.",
        },
    },

    options: {
        guildId: {
            type: "string" as const,
            required: false,
            description: "Restrict to a specific server ID. Leave empty to listen across all servers.",
        },
        channelIds: {
            type: "string" as const,
            required: false,
            description: "Comma-separated channel IDs to listen on. Leave empty to listen on all channels.",
        },
        mentionOnly: {
            type: "boolean" as const,
            default: false,
            description: "Only trigger when the bot is @mentioned.",
        },
        prefix: {
            type: "string" as const,
            default: "",
            description: "Optional message prefix required to trigger the agent (e.g. '!ask'). Ignored if empty.",
        },
    },

    emits: {
        "discord:message.received": {} as {
            content: string
            userId: string
            username: string
            channelId: string
            guildId: string | null
            messageId: string
            reply: (text: string) => Promise<void>
        },
    },

    async setup({ axon, options }) {
        const token = axon.env.require("DISCORD_BOT_TOKEN")

        const allowedChannels = options.channelIds
            ? options.channelIds.split(",").map(s => s.trim()).filter(Boolean)
            : []

        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildPresences,
                GatewayIntentBits.GuildMembers,
            ],
        })

        // Serialise hook calls so concurrent messages don't interleave.
        let messageQueue = Promise.resolve()

        client.on(Events.MessageCreate, (msg: Message) => {
            if (msg.author.bot) return
            if (options.guildId && msg.guildId !== options.guildId) return
            if (allowedChannels.length > 0 && !allowedChannels.includes(msg.channelId)) return
            if (options.mentionOnly && !msg.mentions.has(client.user!)) return

            const prefix = options.prefix ?? ""
            if (prefix && !msg.content.startsWith(prefix)) return

            let content = msg.content
            if (prefix) content = content.slice(prefix.length).trim()
            if (client.user) {
                content = content.replace(`<@${client.user.id}>`, "").trim()
                content = content.replace(`<@!${client.user.id}>`, "").trim()
            }

            const payload = {
                content,
                userId: msg.author.id,
                username: msg.author.username,
                channelId: msg.channelId,
                guildId: msg.guildId,
                messageId: msg.id,
                reply: async (text: string) => { await msg.reply(text) },
            }

            messageQueue = messageQueue
                .then(() => axon.callHook("discord:message.received", payload))
                .catch(() => {})
        })

        await client.login(token)

        axon.hook("axon:agent:shutdown", async () => { await client.destroy() })
    },
})

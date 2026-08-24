import {
    Client,
    GatewayIntentBits,
    Events,
    type Message,
} from "discord.js"

/**
 * Discord — a sense organ for the agent.
 *
 * Inbound messages become text stimuli on channel `discord:<channelId>`,
 * exactly like text typed at the terminal — which arrives on `user`. AIR
 * renders that channel onto the turn, so the brain sees WHERE each message
 * came from and can hold two conversations at once without confusing them.
 *
 * Outbound is the `discord.send` tool, which the brain calls deliberately with
 * the address it read off the stimulus it is answering. Deliberately a tool and
 * not a direct output: a reply needs a target, and an output that carried one
 * would make every emission a routing decision.
 *
 * There are no hooks here. An earlier version emitted `discord:message.received`
 * carrying a `reply` closure, and a server plugin answered it with its own
 * `axon.request()` — which spawned an isolated wake per message and bypassed
 * the scheduler, so the agent had no continuity across its own conversation.
 * Each message was answered by a mind that remembered nothing of the last one.
 * Sensing through `stim` puts Discord on the same footing as every other
 * channel: one session, one mind, many senses.
 *
 * The gateway lives here, in the agent runtime. The tool surface is REST-only
 * and runs in the capsule — a different process, which is why it reads the
 * token from its own env rather than sharing this client.
 */

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

    async setup({ axon, options }) {
        /**
         * Absent token DEGRADES; it does not abort the boot.
         *
         * `env.require` throws, and a throw in setup() is total — no later
         * module is wired and the agent does not come up. That is right for a
         * module that is broken, and wrong for one that is merely not
         * connected yet: installing @axon/discord and setting the token are
         * two separate moments, and `:connect discord` puts a whole guided
         * flow between them. Requiring the token made the agent unbootable
         * for the entire duration of its own setup flow — and unbootable is
         * also unable to run the command that fixes it.
         *
         * So a missing token leaves the agent running with one sense organ
         * unconnected, says so once, and connects on the next reload — which
         * `setKey` triggers the moment the credential lands.
         */
        const token = axon.env.get("DISCORD_BOT_TOKEN")
        if (!token) {
            await axon.warn(
                "DISCORD_BOT_TOKEN is not set — Discord is installed but not connected. Run `:connect discord`.",
            )
            return
        }

        const allowedChannels = options.channelIds
            ? options.channelIds.split(",").map(s => s.trim()).filter(Boolean)
            : []

        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ],
        })

        // Serialise stimuli so two messages arriving together reach the session
        // in the order Discord delivered them. This is ordering, not
        // throttling — `stim` hands the session a sense datum and returns; the
        // scheduler decides when to wake and answers both from one mind.
        let queue = Promise.resolve()

        client.on(Events.MessageCreate, (msg: Message) => {
            if (msg.author.bot) return
            if (options.guildId && msg.guildId !== options.guildId) return
            if (allowedChannels.length > 0 && !allowedChannels.includes(msg.channelId)) return
            // Strict direct-mention only. discord.js's has() defaults to true
            // for @everyone/@here, role mentions the bot shares, and the
            // replied-to user — so a message that only visibly @-mentions
            // someone else (or uses @everyone) would otherwise trigger the bot.
            if (
                options.mentionOnly &&
                !msg.mentions.has(client.user!, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })
            ) return

            const prefix = options.prefix ?? ""
            if (prefix && !msg.content.startsWith(prefix)) return

            let content = msg.content
            if (prefix) content = content.slice(prefix.length).trim()
            if (client.user) {
                content = content.replace(`<@${client.user.id}>`, "").trim()
                content = content.replace(`<@!${client.user.id}>`, "").trim()
            }

            // The CHANNEL is the return address the brain hands to
            // discord.send — the channel id, not the guild, because a DM has
            // no guild and a reply always goes to the channel it came from.
            //
            // The sender stays in the content deliberately. Who is speaking is
            // something the mind should weigh — including whether to trust
            // them — while the channel is pure routing.
            queue = queue
                .then(() => axon.stim("cognet:stimulus:text", {
                    channel: `discord:${msg.channelId}`,
                    content: `${msg.author.username}: ${content}`,
                }))
                .then(() => undefined)
                .catch((error: unknown) => {
                    // Never swallow silently: a message that fails to reach the
                    // session has vanished with no trace. Log and continue so
                    // one bad message doesn't wedge every message after it.
                    console.error(`[discord] could not deliver message ${msg.id}:`, error)
                })
        })

        await client.login(token)

        axon.onDispose(async () => { await client.destroy() })
    },
})

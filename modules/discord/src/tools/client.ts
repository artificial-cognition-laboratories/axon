import { Client, Events, GatewayIntentBits } from "discord.js"

let _client: Client | null = null
let _ready: Promise<Client> | null = null

/**
 * Returns a logged-in Discord client, initializing once on first call.
 * Waits for the client to be fully ready before resolving.
 * Reads DISCORD_BOT_TOKEN from the environment (injected at capsule boot).
 */
export async function getClient(): Promise<Client> {
    if (_ready) return _ready

    const token = process.env.DISCORD_BOT_TOKEN
    if (!token) throw new Error("DISCORD_BOT_TOKEN is not set in the capsule environment.")

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

    _ready = new Promise<Client>((resolve, reject) => {
        client.once(Events.ClientReady, () => {
            _client = client
            resolve(client)
        })
        client.once(Events.Error, reject)
        client.login(token).catch(reject)
    })

    return _ready
}

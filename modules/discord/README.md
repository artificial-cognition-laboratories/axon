# @axon/discord

Adds a Discord bot to your agent. Incoming messages fire a hook your plugin handles.

## Setup

1. Create a bot at [discord.com/developers](https://discord.com/developers) and copy the token
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**
3. Invite the bot to your server with the `bot` scope and `Send Messages` + `Read Message History` permissions
4. Add `DISCORD_BOT_TOKEN` to your agent's `.env`

## Config

```ts
// axon.config.ts
modules: {
    discord: {
        channelIds: "123456789,987654321",  // optional — omit to listen everywhere
        mentionOnly: false,                  // only trigger on @mentions
        prefix: "!ask",                      // require a prefix — ignored if empty
        guildId: "111222333",               // restrict to one server — omit for all
    }
}
```

## Handling messages

```ts
// server/plugins/discord.ts
export default defineAxonPlugin(async (axon) => {
    axon.hooks.on("discord:message.received", async ({ content, username, reply }) => {
        const prompt = await axon.prompt("discord", { content, username })
        const response = await axon.request({ prompt: [prompt] })
        if (response?.text) await reply(response.text)
    })
})
```

Messages are queued — if the agent is still processing one message when the next arrives,
it waits. The agent's cognitive loop is never called concurrently.

## Hook payload

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | Message text, stripped of prefix and @mention |
| `username` | `string` | Discord username of the sender |
| `userId` | `string` | Discord user ID |
| `channelId` | `string` | Channel the message arrived in |
| `guildId` | `string \| null` | Server ID — `null` for DMs |
| `messageId` | `string` | Discord message ID |
| `reply` | `(text: string) => Promise<void>` | Send a reply in the same channel |

## Prompt

The module ships a `discord` prompt that frames the inbound message for the agent.
Override it by creating `src/prompts/discord.vue` in your agent — agent-owned prompts take precedence.

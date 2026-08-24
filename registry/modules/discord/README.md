# @axon/discord

Adds a Discord bot to your agent. Messages the bot can see arrive as stimuli;
the agent replies with the `discord.send` tool.

No plugin, no handler — install it, set the token, and the agent is in Discord.

## Setup

1. Create an application at [discord.com/developers](https://discord.com/developers/applications) → **New Application**
2. **Bot → Reset Token → Copy**
3. Invite the bot with the `bot` scope and **Send Messages** + **Read Message History**
4. Add `DISCORD_BOT_TOKEN` to your agent's `.env`

Or run `:connect discord` in the terminal, which walks all four and verifies the
token before it writes anything.

## Config

```ts
// axon.config.ts
export default defineAgent({
    modules: ["@axon/discord"],

    // or, with options
    modules: [
        ["@axon/discord", {
            channelIds: "123456789,987654321",  // optional — omit to listen everywhere
            mentionOnly: false,                  // only trigger on @mentions
            prefix: "!ask",                      // require a prefix — ignored if empty
            guildId: "111222333",                // restrict to one server — omit for all
        }],
    ],
})
```

## How it works

An inbound message becomes a text stimulus on channel `discord:<channelId>` —
the same door text typed at the terminal comes through, which arrives on
`user`. The agent sees where each message came from and can hold two
conversations at once without confusing them.

The sender travels in the content (`cody: did the deploy finish?`) rather than
in the channel. Who is speaking is something the mind should weigh, including
whether to trust them; the channel is pure routing.

Replies go out through the `discord.send` tool, which the agent calls with the
channel it read off the message it is answering:

```ts
await discord.send("discord:123456789", "Deploy finished — all green.")
```

There is deliberately no "reply to the last sender" — that is a hidden global
that misroutes the moment two people write at once.

## Tools

| Tool | Purpose |
|------|---------|
| `discord.send(channel, text)` | Reply to a channel. Takes the stimulus's channel address. |
| `discord.history(channelId, limit)` | Read recent messages, oldest first, max 50. |
| `discord.channels(guildId)` | List text channels in a server. |

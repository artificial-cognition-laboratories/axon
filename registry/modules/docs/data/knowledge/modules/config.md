---
title: module.config.ts
---

# module.config.ts

The entry point for every module. Declares identity, configuration, env requirements,
emitted hooks, and the boot lifecycle in one place.

```ts
export default defineModule({
    name: "discord",
    description: "Discord bot integration — receive messages and send replies.",

    env: {
        DISCORD_BOT_TOKEN: {
            required: true,
            description: "Bot token from the Discord developer portal.",
        },
    },

    options: {
        mentionOnly: { type: "boolean", default: false },
        channelIds:  { type: "string",  required: false },
    },

    emits: {
        "discord:message.received": {} as {
            content: string
            username: string
            reply: (text: string) => Promise<void>
        },
    },

    async setup({ axon, options }) {
        const token = axon.env.require("DISCORD_BOT_TOKEN")
        // ...
    },
})
```

Axon reads the static fields at install time without executing any code. `setup` runs
once at agent boot.

## name

The module's registry identifier. Lowercase, hyphenated. Combined with your account
scope on publish:

```ts
export default defineModule({ name: "discord" })  // → @you/discord on the registry
```

## description

One line. Shown in the registry and the TUI module browser.

## env

Env keys the module requires. The installing agent adds these to their `.env`. Axon
validates presence at boot.

```ts
export default defineModule({
    env: {
        DISCORD_BOT_TOKEN: {
            required: true,
            description: "Bot token from the Discord developer portal.",
        },
        DISCORD_GUILD_ID: {
            required: false,
            description: "Restrict to a specific server. Leave empty for all servers.",
        },
    },
})
```

Inside `setup`, use `axon.env.require()` to validate and retrieve:

```ts
const token = axon.env.require("DISCORD_BOT_TOKEN")   // throws if missing
const guild = axon.env.get("DISCORD_GUILD_ID")         // returns undefined if absent
```

## options

User-configurable settings for the module. Set by the installing agent in
`axon.config.ts`. Passed to `setup` as the `options` parameter.

```ts
export default defineModule({
    options: {
        mentionOnly: {
            type: "boolean",
            default: false,
            description: "Only trigger when the bot is @mentioned.",
        },
        channelIds: {
            type: "string",
            required: false,
            description: "Comma-separated channel IDs. Empty means all channels.",
        },
    },
})
```

The installing agent configures them. `modules` is an **array** of entries; to
pass options, use a `[module, options]` tuple:

```ts
// axon.config.ts
export default defineAgent({
    modules: [
        ["@axon/discord", { mentionOnly: true, channelIds: "1234567890" }],
    ],
})
```

A module with no options is just its name (or import):

```ts
modules: ["@axon/discord", "@axon/fs"]
```

Options are validated against the declared types before `setup` runs.

## emits

Named hooks the module fires during its lifetime. The type cast (`{} as { ... }`)
is the payload type — it flows through to the subscription site so the agent author
gets typed payloads.

```ts
export default defineModule({
    emits: {
        "discord:message.received": {} as {
            content: string
            username: string
            channelId: string
            reply: (text: string) => Promise<void>
        },
    },
})
```

Inside `setup`, fire hooks with `axon.callHook`:

```ts
await axon.callHook("discord:message.received", {
    content: msg.content,
    username: msg.author.username,
    channelId: msg.channelId,
    reply: (text) => msg.reply(text),
})
```

## policy

Declares what capabilities the module uses. Advisory — the parent agent grants actual
access through its own policy block. A module cannot expand policy, only declare its
intentions.

```ts
export default defineModule({
    policy: {
        network: { needs: ["discord.com", "gateway.discord.gg"] },
        fs:      { needs: ["data/**"] },
        process: { needs: ["git *"] },
    },
})
```

## modules

Other modules this module depends on. Resolved and merged automatically when this
module is installed — the agent author sees one install.

```ts
export default defineModule({
    modules: ["@axon/fs", "@you/shared-prompts"],
})
```

## setup

Runs once at agent boot. Narrow scope: env validation, external service connections,
hook registration, and teardown.

```ts
async setup({ axon, options }) {
    const token = axon.env.require("DISCORD_BOT_TOKEN")
    const client = new Client({ ... })

    client.on(Events.MessageCreate, async (msg) => {
        await axon.callHook("discord:message.received", { ... })
    })

    await client.login(token)

    axon.hook("axon:agent:shutdown", () => client.destroy())
}
```

For polling modules, wait for `server:ready` before starting — all plugins need to
be registered before the first hook fires:

```ts
axon.hook("server:ready", () => startPolling())
```

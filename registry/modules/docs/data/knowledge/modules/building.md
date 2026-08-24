---
title: Building a Module
---

# Building a Module

A module starts as a folder with a `module.config.ts`. Everything else is optional
depending on what the module contributes.

```bash
my-module/
├── server/
│   └── api/
├── src/
│   ├── prompts/
│   └── tools/
├── module.config.ts
└── package.json
```

## Start with module.config.ts

The config declares everything about the module — its identity, what env keys it
needs, what hooks it emits, and its boot lifecycle.

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
        prefix:      { type: "string",  default: "" },
    },

    emits: {
        "discord:message.received": {} as {
            content: string
            username: string
            channelId: string
            reply: (text: string) => Promise<void>
        },
    },

    async setup({ axon, options }) {
        const token = axon.env.require("DISCORD_BOT_TOKEN")
        const client = new Client({ intents: [...] })

        client.on(Events.MessageCreate, async (msg) => {
            if (options.mentionOnly && !msg.mentions.has(client.user!)) return

            await axon.callHook("discord:message.received", {
                content: msg.content,
                username: msg.author.username,
                channelId: msg.channelId,
                reply: (text) => msg.reply(text),
            })
        })

        await client.login(token)

        axon.hook("axon:agent:shutdown", () => client.destroy())
    },
})
```

## options

Options make modules configurable at install time. The installing agent sets them in
`axon.config.ts`. The module receives them in `setup({ options })`.

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
            description: "Comma-separated channel IDs to listen on.",
        },
    },
})
```

Options are typed and validated before `setup` runs. Use them to avoid hardcoding
behaviour that different agents will want to configure differently.

## emits and the hook/prompt pattern

`emits` declares the hooks your module fires. Types flow through to the subscription
site — the agent author gets typed payloads when they call `axon.hooks.hook(...)`.

The canonical pattern: the module emits the hook, the agent author loads a prompt
with the hook payload and calls the agent:

```ts
// agent's server/plugins/discord.ts
axon.hooks.hook("discord:message.received", async ({ content, username, reply }) => {
    const prompt = await axon.prompt("discord/discord", { content, username })
    const result = await axon.request({ prompt })
    await reply(result.text)
})
```

Contribute the prompt alongside the hook so the agent author has something to start
with. Put it in `src/prompts/` — it becomes available as `axon.prompt("discord/discord")`.

## setup lifecycle

`setup` runs once at agent boot. It is the right place to:

- validate required env keys with `axon.env.require()`
- connect to external services (Discord client, IMAP connection, database)
- register teardown on `axon:agent:shutdown`
- start polling loops, but only after `server:ready` fires

```ts
async setup({ axon, options }) {
    // validate first — fail fast if misconfigured
    const token = axon.env.require("DISCORD_BOT_TOKEN")

    // connect
    const client = new Client({ ... })
    await client.login(token)

    // always register teardown
    axon.hook("axon:agent:shutdown", () => client.destroy())

    // if you poll, wait for server:ready so all plugins are registered first
    axon.hook("server:ready", () => startPolling())
}
```

The `server:ready` hook matters for polling modules. Plugins that subscribe to your
hooks need to be registered before you start emitting. `server:ready` fires after all
plugins are loaded.

## Adding tools

Export async functions from `src/tools/`. Each file becomes a namespace on
`axon.tools`. A file named `email.ts` contributes `axon.tools.email.*`:

```ts
// src/tools/email.ts
export async function send(to: string, subject: string, body: string): Promise<void> {
    const sgMail = (await import("@sendgrid/mail")).default
    sgMail.setApiKey(process.env.SENDGRID_API_KEY!)
    await sgMail.send({ to, from: process.env.EMAIL_FROM!, subject, text: body })
}
```

Run `axon module prepare` to generate type declarations. The installing agent gets
`axon.tools.email.send(...)` fully typed.

## Adding routes

Routes in `server/api/` are mounted on the parent agent's HTTP server. The canonical
use is webhook receivers — verify the signature, normalize the payload, emit the hook:

```ts
// server/api/github.post.ts
export default defineEventHandler(async (event) => {
    const rawBody = (await readRawBody(event)) ?? ""
    const sig = getRequestHeader(event, "x-hub-signature-256") ?? ""

    if (!verifySignature(rawBody, sig, process.env.GITHUB_WEBHOOK_SECRET!)) {
        throw createError({ statusCode: 403, message: "invalid signature" })
    }

    const payload = JSON.parse(rawBody)

    await axon.callHook("github:issue.opened", {
        number: payload.issue.number,
        title: payload.issue.title,
    })

    return { ok: true }
})
```

The module ships the route. The agent author never writes webhook verification code.

## npm dependencies

Declare external packages in `package.json`. They are incorporated into the parent
agent's environment on install:

```json
{
    "name": "my-module",
    "version": "0.1.0",
    "dependencies": {
        "discord.js": "^14.16.3"
    }
}
```

Keep dependencies minimal. Every package you add is installed into every agent that
uses the module.

## Testing

Module tests boot a parent agent with the module installed and assert on the contribution
surface — tools registered, prompts renderable, hooks firing correctly. See
[Module tests](/docs/v2/modules/tests) for the full reference.

## Publishing

When the module is ready:

```bash
axon module prepare   # generate type declarations
axon module deploy    # publish to registry
```

See [Publishing](/docs/v2/modules/publishing) for versioning and registry identity.

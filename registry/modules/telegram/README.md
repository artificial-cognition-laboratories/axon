# @axon/telegram

Telegram as a **sense channel** for your agent. Messages sent to your bot arrive as text stimuli — the same way text typed at the terminal does. The agent replies by calling one tool.

The primary use case: your agent, on your phone. No app to build, no auth to manage.


## Setup

**1. Create a bot** — message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. You get a token like `123456789:ABC-...`.

**2. Install**

```bash
axon install @axon/telegram
```

**3. Configure** — add the token to your agent's `.env`:

```
TELEGRAM_BOT_TOKEN=123456789:ABC-...
```

Optionally restrict which chats it listens to, in `axon.config.ts`. This is a wiring choice, not a trust boundary — the sender travels with each message so the agent can judge it:

```typescript
modules: [
    ["@axon/telegram", { chatIds: "123456789" }],
]
```

**4. Run** — `axon prepare && axon dev`, then message your bot. Telegram won't let a bot open a chat first, so send it something before expecting a reply.


## The shape

```
inbound   message → axon.stim("cognet:stimulus:text", {
                        channel: "telegram:123456789",
                        content: "cody: hey",
                    })

                  → the model sees:
                    <user channel="telegram:123456789">cody: hey</user>

outbound  telegram.send("telegram:123456789", "Hey.")
```

**Sense in, act out.** Input is involuntary — the world reaches the agent whether it wants it or not — so it arrives as a stimulus, and the arrival itself wakes the agent. Output is voluntary — choosing to speak, and to whom, is cognition — so it is a tool the brain calls.

The channel is rendered onto the turn, so the address the model needs to reply is attached to the message rather than buried in it. It answers by passing that address back to `send`, which keeps replies correct when two people write at once.


## `telegram.send(channel, text, options?)`

Markdown by default. Attachments ride in the options; Telegram carries one document per message, so the text becomes the caption of the first.

Returns a receipt — `{ ok: true, channel, chatId, messageIds }`. A send is a write the agent is waiting on, so it comes back as evidence it happened rather than as `void`: a tool that returns nothing echoes `null` into the capsule result, which reads as failure, and an agent that believes its reply failed sends it again.

```typescript
await telegram.send(channel, "Deploy finished — **all green**.")
await telegram.send(channel, "Here's the report.", {
    attachments: [{ path: "/tmp/report.pdf" }],
})
```

| Option | Type | Description |
|---|---|---|
| `attachments` | `{ path, name? }[]` | Files to attach from disk. |
| `markdown` | `boolean` | Parse as Markdown. Default `true`. |

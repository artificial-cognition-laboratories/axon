# @axon/telegram

Telegram bot integration for Axon agents. Receive messages, commands, and button taps via long-polling. Send replies, markdown, inline keyboards, typing indicators, and files.

The primary use case: a mobile interface for your agent. Message your bot on Telegram, get responses back. No app to build, no auth to manage — Telegram handles the UI.

---

## Setup

**1. Create a bot**

Message [@BotFather](https://t.me/BotFather) on Telegram:
```
/newbot
```
Follow the prompts. You'll get a token like `123456789:ABC-...`.

**2. Install the module**

```bash
axon install @axon/telegram
```

**3. Configure**

Add to your agent's `.env`:

```
TELEGRAM_BOT_TOKEN=123456789:ABC-...
TELEGRAM_ALLOWED_USERS=123456789
```

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

`TELEGRAM_ALLOWED_USERS` is strongly recommended for personal bots — without it, anyone who finds your bot can talk to your agent. Comma-separate multiple IDs for shared access.

**4. Wire up a plugin**

Copy `server/plugins/telegram.ts` from the module into your agent's `server/plugins/` directory and adapt it to your agent's behaviour.

**5. Prepare and run**

```bash
axon prepare
axon dev
```

---

## Hooks

The module emits three hooks. Subscribe in a server plugin.

### `telegram:message`

Fires when a user sends a plain text message (not a command).

```typescript
axon.hooks.on("telegram:message", async ({ text, chatId, username, reply, replyMarkdown, replyWithButtons }) => {
    await telegram.typing(chatId)
    const prompt = await axon.prompt("telegram/message", { text, username })
    const result = await axon.request({ prompt })
    await reply(result.text)
})
```

Payload:

| Field | Type | Description |
|---|---|---|
| `text` | `string` | The message text |
| `chatId` | `number` | Chat to reply to |
| `userId` | `number` | Sender's Telegram user ID |
| `username` | `string \| null` | Sender's @username if set |
| `messageId` | `number` | Message ID |
| `reply(text)` | `fn` | Send a plain text reply |
| `replyMarkdown(text)` | `fn` | Send a markdown reply |
| `replyWithButtons(text, buttons)` | `fn` | Send a reply with inline keyboard |

---

### `telegram:command`

Fires when a user sends a `/command`. Commands are split from their arguments automatically.

```typescript
axon.hooks.on("telegram:command", async ({ command, args, reply }) => {
    switch (command) {
        case "review":
            const prNumber = parseInt(args[0], 10)
            // ...
            break
        case "status":
            await reply("All systems running.")
            break
    }
})
```

Payload:

| Field | Type | Description |
|---|---|---|
| `command` | `string` | Command name without `/`. e.g. `"review"` for `/review 42` |
| `args` | `string[]` | Arguments after the command. e.g. `["42"]` for `/review 42` |
| `chatId` | `number` | Chat to reply to |
| `userId` | `number` | Sender's user ID |
| `username` | `string \| null` | Sender's @username |
| `reply(text)` | `fn` | Send a plain text reply |
| `replyMarkdown(text)` | `fn` | Send a markdown reply |
| `replyWithButtons(text, buttons)` | `fn` | Send a reply with inline keyboard |

---

### `telegram:button`

Fires when a user taps an inline keyboard button created with `telegram.sendButtons()`.

```typescript
axon.hooks.on("telegram:button", async ({ data, answer, reply }) => {
    await answer("Processing...")   // always call this first — clears the spinner
    const [action, id] = data.split(":")
    if (action === "review") {
        const pr = await prs.get("owner", "repo", parseInt(id))
        await reply(`Reviewing PR #${id}: ${pr.title}`)
    }
})
```

Payload:

| Field | Type | Description |
|---|---|---|
| `data` | `string` | The payload set when the button was created (max 64 bytes) |
| `queryId` | `string` | Callback query ID — passed to `answerCallback` |
| `chatId` | `number` | Chat the button was in |
| `userId` | `number` | User who tapped the button |
| `messageId` | `number` | Message the button was attached to |
| `answer(text?)` | `fn` | Dismiss the loading spinner. Optional toast text (max 200 chars). Always call this. |
| `reply(text)` | `fn` | Send a new message to the chat |

---

## Tools

Available as `telegram.*` after install.

### `telegram.send(chatId, text)`

Send a plain text message.

```typescript
await telegram.send(chatId, "Task complete.")
// → { messageId, chatId }
```

### `telegram.sendMarkdown(chatId, text)`

Send a message with Markdown formatting. Supports `**bold**`, `_italic_`, `` `code` ``, ` ```blocks``` `.

```typescript
await telegram.sendMarkdown(chatId, "**3 errors** found in `src/auth.ts`")
```

### `telegram.sendButtons(chatId, text, buttons)`

Send a message with an inline keyboard. Buttons are arranged in rows — buttons in the same row appear side by side.

```typescript
await telegram.sendButtons(chatId, "Which PR should I review?", [
    [
        { label: "#42 auth fix",       data: "review:42" },
        { label: "#43 rate limiting",  data: "review:43" },
    ],
    [{ label: "Skip for now", data: "review:skip" }],
])
```

`data` is delivered to the `telegram:button` hook when the button is tapped. Max 64 bytes.

### `telegram.edit(message, text)`

Edit a previously sent message in place. Use to simulate streaming output.

```typescript
const msg = await telegram.send(chatId, "Thinking...")
// ... agent runs ...
await telegram.edit(msg, "Done — found 3 issues.")
```

### `telegram.editMarkdown(message, text)`

Edit a message with Markdown formatting.

### `telegram.typing(chatId)`

Show "typing..." indicator. Lasts ~5 seconds. Call before long operations.

```typescript
await telegram.typing(chatId)
const result = await longOperation()
await telegram.send(chatId, result)
```

### `telegram.sendFile(chatId, filePath, caption?)`

Upload and send a file from disk.

```typescript
await telegram.sendFile(chatId, "/tmp/report.pdf", "Weekly analysis")
await telegram.sendFile(chatId, "/tmp/diff.txt")
```

### `telegram.answerCallback(queryId, text?)`

Answer a callback query directly. The `answer()` helper in `telegram:button` calls this automatically — use this only if you need to answer a query outside the hook handler.

---

## Streaming pattern

Telegram doesn't support true streaming, but editing a message in place looks live:

```typescript
axon.hooks.on("telegram:message", async ({ text, chatId, reply }) => {
    await telegram.typing(chatId)

    // Send placeholder
    const msg = await telegram.send(chatId, "...")

    // Stream chunks by editing in place
    let accumulated = ""
    for await (const chunk of agentStream) {
        accumulated += chunk
        await telegram.edit(msg, accumulated)
    }
})
```

---

## How it works

The module uses **long-polling** — it calls Telegram's `getUpdates` with a 30-second timeout, processes any updates that arrived, then immediately polls again. No public URL or webhook setup required. Works behind NAT, on localhost, in any environment where outbound HTTPS is allowed.

The polling loop starts after `server:ready` fires (all plugins registered) and stops cleanly on `axon:agent:shutdown`.

---

## Security

**Always set `TELEGRAM_ALLOWED_USERS`** for personal bots. Without it, any Telegram user who finds or guesses your bot's username can send messages to your agent.

Your bot is not listed publicly unless you ask BotFather to add it to Telegram's bot directory. But bot usernames are guessable — the allowlist is the only reliable guard.

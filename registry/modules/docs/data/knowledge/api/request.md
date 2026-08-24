---
title: axon.request
---

# axon.request

Sends a prompt to the agent loop and waits for it to finish. Returns all entries
produced during that turn plus the agent's final message as plain text.

```ts
// Shorthand — string prompt
const result = await axon.request("summarise the open issues")

// result.text      — agent's final message as a plain string
// result.entries   — full entry timeline (tool calls, stdout, message, etc.)
```

With options:

```ts
const result = await axon.request({
    prompt: "summarise the open issues",
    policy: { ... },      // narrow the active policy for this call only
})
```

Use `request` when you need the full result before continuing — extracting text,
passing it to the next call, writing it to a file.

```ts
const { domain } = defineArgs<{ domain: string }>()
const learnPrompt = await axon.prompt("learn", { domain })

const result = await axon.request({ prompt: learnPrompt })

const match = result.text.match(/```knowledge\n([\s\S]*?)```/)
if (match) {
    await writeFile(`data/knowledge/${domain}.md`, match[1].trim())
}
```

## prompt accepts an array

Pass an array of rendered prompts and Axon concatenates them in order before
sending. The standard pattern — session context first, task-specific prompt second:

```ts
const context = await axon.prompt("context")   // current project state
const task    = await axon.prompt("close-plan", { issueId })

const result = await axon.request({ prompt: [context, task] })
```

## Entries

`result.entries` is the full typed timeline for that turn. The most commonly used:

```ts
// result.text is shorthand for this entry's payload.content
entry.type === "axon:agent:message"         // final agent message
entry.type === "capsule:stdout"             // tool process output — payload.data
entry.type === "pathway:complete"           // loop finished — payload.durationMs, billing
```

See [axon.stream](/docs/v2/api/stream) for the streaming equivalent.

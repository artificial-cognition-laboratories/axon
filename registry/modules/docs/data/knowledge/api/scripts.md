---
title: axon.scripts
---

# axon.scripts

Invoke another script from within a script or route handler. The target script runs
in the same agent instance — same tools, same session, same conversation.

## axon.scripts.request

Runs the script and waits for it to finish. Returns the same result shape as
`axon.request`.

```ts
const result = await axon.scripts.request("close-plan", { issueId: "bd-yiq" })

console.log(result.text)
```

Arguments become available inside the target script via `defineArgs`:

```ts
// src/scripts/close-plan.ts
const { issueId } = defineArgs<{ issueId: string }>()
```

## axon.scripts.stream

Runs the script and streams entries as they arrive. Useful when the target script
itself calls `axon.stream` and you want to forward that output incrementally.

```ts
const { stream } = axon.scripts.stream("scout")

for await (const entry of stream) {
    if (entry.type === "axon:agent:message:delta") {
        process.stdout.write(entry.payload.content)
    }
}
```

## When to use this

Scripts are the primary unit of agent automation. `axon.scripts` lets you compose
them — a route handler can delegate to a script, a script can chain into another.

```ts
// server/api/close.ts
export default defineEventHandler(async (event) => {
    const { issueId } = await readBody(event)

    const { stream } = axon.scripts.stream("close-plan", { issueId })

    return sendStream(event, stream)
})
```

This keeps route handlers thin. The logic lives in the script; the route just
wires the HTTP surface to it.

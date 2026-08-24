---
title: axon.ui
---

# axon.ui

`axon.ui` is the narrow host interaction surface. It lets route code, scripts, and policy escalation handlers ask the connected TUI for a decision.

It is not the agent loop. It does not call the engine. It must never block forever.

## `axon.ui.ask`

Use `axon.ui.ask(...)` when code needs an explicit user decision before continuing.

```ts
const decision = await axon.ui.ask({
    message: "Deploy to production?",
    options: ["deploy", "cancel"],
    timeoutMs: 60_000,
})

if ("unavailable" in decision || "timeout" in decision) {
    return { status: "cancelled", message: "No changes were made." }
}

if (decision.selected !== "deploy") {
    return { status: "cancelled", message: "No changes were made." }
}
```

Return shape — discriminated by key presence:

- `{ selected: string }` — user picked an option
- `{ timeout: true }` — no answer before `timeoutMs`
- `{ unavailable: true }` — no connected TUI host

Rules:

- If no host can answer, `axon.ui.ask` returns `{ unavailable: true }`.
- If no answer arrives before `timeoutMs`, it returns `{ timeout: true }`.
- Headless and background agents must not assume a connected UI.
- Always return an HTTP response from routes.

## Policy escalation

Policy escalation is separate from `axon.ui.ask(...)`. Escalation is raised by the runtime or capsule when policy requires approval for a mediated action. A hook may use `axon.ui.ask(...)` to ask the connected user.

```ts
axon.hooks.hook("policy:escalation", async request => {
    const decision = await axon.ui.ask({
        message: request.title ?? "Approve action?",
        options: ["allow", "deny"],
        timeoutMs: request.timeoutMs,
    })

    return {
        allow: "selected" in decision && decision.selected === "allow",
        reason: "selected" in decision ? decision.selected : Object.keys(decision)[0],
    }
})
```

If no resolver or connected host can answer, escalation denies. V1 does not include external approval inboxes, durable approval queues, or background approval workflows.

## What is excluded

`axon.ui` is deliberately small:

- no layout control
- no custom panels
- no arbitrary TUI mutation
- no direct auth changes
- no policy bypass

The UI can ask and display. Axon still owns runtime semantics.

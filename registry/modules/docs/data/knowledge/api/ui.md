---
title: axon.ui
---

# axon.ui

Request input from a connected TUI host. When the agent is running headlessly —
via `axon run`, a cron job, or a route handler — `axon.ui` returns `{ unavailable }`
rather than blocking.

```ts
const response = await axon.ui.ask({
    message: "Which approach should I take?",
    options: ["refactor", "rewrite", "leave it"],
})

if ("unavailable" in response) {
    // no connected host — fall back to a default or skip the decision
} else {
    console.log(response.selected)   // what the user picked
}
```

## Why this exists

Some scripts benefit from a human decision mid-run — a confirmation before a
destructive action, a choice between approaches, a review gate. `axon.ui` lets
scripts surface those moments to a TUI user without hardcoding a blocking prompt
that would break headless execution.

The `unavailable` check is the contract: any script that calls `axon.ui` must
handle the headless case explicitly. The runtime never blocks waiting for input
that may never come.

## axon.ui.ask

Presents a question with a fixed set of options. Returns whichever the user selects.

```ts
const response = await axon.ui.ask({
    message: "Proceed with the migration?",
    options: ["yes", "no", "show me the diff first"],
})

if ("selected" in response) {
    if (response.selected === "no") process.exit(0)
}
```

## Timeout

If the user doesn't respond within the configured timeout, `ask` returns
`{ timeout: true }` rather than blocking indefinitely.

```ts
if ("timeout" in response) {
    // user didn't respond — proceed with default
}
```

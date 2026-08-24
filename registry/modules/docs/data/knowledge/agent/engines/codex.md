---
title: Codex
---

# Codex

OpenAI's Codex engine, connected via OAuth. Requires a ChatGPT Plus or Pro subscription.
No API key — authentication is handled through a browser flow.

## Setup

Authenticate from the TUI:

```bash
:keys set openai connect
```

This opens a browser window. Once you approve, Codex models appear in the model palette.
The connection auto-refreshes — you won't need to reconnect unless you explicitly
disconnect.

To manage the connection:

```bash
:keys set openai reconnect    # re-authenticate
:keys set openai disconnect   # remove authentication
:keys show                    # check current state
```

## Configuration

```ts
import { Codex } from "@arcforge/engines"

export default defineAgent({
    engine: Codex(),
})
```

With options:

```ts
import { Codex } from "@arcforge/engines"

export default defineAgent({
    engine: Codex({
        model: "gpt-5.5",     // default
        effort: "medium",     // low | medium | high | xhigh
    }),
})
```

`effort` controls reasoning depth on models that support it. Higher effort increases
latency and token usage. Omit it for non-reasoning models.

## Switching models

Open the model palette with `*`. All Codex models appear once authenticated. The
selected model overrides the `model` field in config for the current session.

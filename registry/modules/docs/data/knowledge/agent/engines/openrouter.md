---
title: OpenRouter
---

# OpenRouter

Bring your own OpenRouter API key and access 100+ models from multiple providers.
Costs go direct to OpenRouter at their rates — no Axon markup.

## Setup

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys), then:

```bash
:keys set openrouter <your-key>
```

Once set, all OpenRouter models appear in the model palette. To verify:

```bash
:keys show
```

## Configuration

```ts
import { OpenRouter } from "@arcforge/engines"

export default defineAgent({
    engine: OpenRouter({ model: "openai/gpt-4o" }),
})
```

`model` is the OpenRouter model ID — `provider/model-name` format as listed on
[openrouter.ai/models](https://openrouter.ai/models).

Common examples:

```ts
OpenRouter({ model: "openai/gpt-4o" })
OpenRouter({ model: "anthropic/claude-sonnet-4-6" })
OpenRouter({ model: "google/gemini-2.5-pro" })
OpenRouter({ model: "meta-llama/llama-3.3-70b-instruct" })
```

## Switching models at runtime

Open the model palette with `*`. All OpenRouter models appear once a key is configured.
Select any to switch — takes effect for the next session.

The selected model overrides the `model` field in `axon.config.ts` for the current
session. Your key remains set across sessions — you only need to set it once.

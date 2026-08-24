---
title: Cerebras
---

# Cerebras

Hosted inference on Cerebras. Use this when latency and high-throughput generation matter
and you want to run supported open models through the Cerebras Inference API.

## Setup

Set a Cerebras API key in the agent environment:

```bash
CEREBRAS_API_KEY=csk-...
```

For deployed agents, set it as a runtime secret rather than committing it to source.

## Configuration

```ts
import { Cerebras } from "@arcforge/engines"

export default defineAgent({
    engine: Cerebras({ model: "gpt-oss-120b" }),
})
```

With options:

```ts
import { Cerebras } from "@arcforge/engines"

export default defineAgent({
    engine: Cerebras({
        model: "gpt-oss-120b",
        temperature: 0.2,
    }),
})
```

`model` is a Cerebras model ID. Use the model list in the Cerebras console or docs for
currently available models.

## When to use it

Use `Cerebras()` for very fast hosted inference, interactive agents where response
latency matters, and workloads built around supported open-weight models.

---
title: engine
---

# engine

Configures which inference provider the agent loop uses. Without this field the
runtime falls back to whatever engine is set in the environment.

```ts
import { Axon, Cerebras, Codex, Ollama, OpenRouter } from "@arcforge/engines"

export default defineAgent({
    engine: Codex(),
})
```

## Managed engine

`Axon()` routes inference through Axon Cloud managed inference. Pass a model to
pin a specific catalog entry, or omit it to use the account default.

```ts
import { Axon } from "@arcforge/engines"

export default defineAgent({
    engine: Axon({ model: "axon-astra-v1" }),
})
```

This is the default when you deploy with `axon deploy`. No key management — the
platform handles it.

## Local engines

Local engines are functions imported from `@arcforge/engines`. The function receives
the message history and returns a string. The runtime calls it inside the loop —
it never has direct access to the inference provider.

```ts
import { Ollama } from "@arcforge/engines"

export default defineAgent({
    engine: Ollama({ model: "llama3.2" }),
})
```

Available engines:

| Import | What it connects to |
|--------|---------------------|
| `Axon()` | Axon Cloud managed inference |
| `Codex()` | ChatGPT subscription Codex via OAuth |
| `Cerebras()` | Cerebras Inference via `CEREBRAS_API_KEY` |
| `Ollama({ model })` | Local Ollama server |
| `OpenRouter({ model })` | OpenRouter via `OPENROUTER_API_KEY` |
| `Mock()` | Deterministic stub for tests |

## engine is not a string

`engine: "gpt-4o"` is not valid. Engine is always an adapter function call such
as `Axon()`, `Cerebras(...)`, `Codex()`, `Ollama(...)`, `OpenRouter(...)`, or
`Mock()`. The string form does not exist.

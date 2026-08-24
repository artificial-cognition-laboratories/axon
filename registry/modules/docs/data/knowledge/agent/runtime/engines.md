---
title: Engines
---

# Engines

An engine is the agent's source of inference — nothing more. The loop, the context
assembly, the tool dispatch, the policy enforcement: all identical regardless of which
engine you pick. Swapping engines changes how the agent thinks, never how it works.

One line in `axon.config.ts` selects it:

```ts
import { Axon, Cerebras, Codex, Ollama, OpenRouter, Mock } from "@arcforge/engines"

export default defineAgent({
    engine: Axon(),
    // engine: Codex()
    // engine: Cerebras({ model: "gpt-oss-120b" })
    // engine: Ollama({ model: "qwen2.5-coder:7b" })
    // engine: OpenRouter({ model: "anthropic/claude-opus-4-5" })
})
```

Your tools, prompts, scripts, and policy don't change. The agent's capabilities — what
it knows, what it can do, what it's allowed to do — are independent of the model
answering the questions.

## Three postures

Engine choice is really a choice about cost, keys, and where tokens go.

**Managed — `Axon()`.** Inference through Axon Cloud, billed to your account. No keys to
manage, works the moment you're logged in. The default, and what a fresh `axon init`
ships with.

**Bring your own — `OpenRouter()`, `Codex()`, `Cerebras()`.** Your key, your provider
relationship, their rates — no Axon markup. Tokens flow from your machine to your
provider; Axon is not in that path. Keys are stored locally in `~/.axon/` and never sent
to Axon servers.

**Local — `Ollama()`.** Inference on your own hardware. No API costs, and no tokens
leave your machine — the strongest privacy posture available. The TUI manages the Ollama
server and model downloads for you.

And one for the test suite: **`Mock()`** replaces inference with a deterministic local
responder. The full loop still runs — tool calls execute, context accumulates — which is
what makes [agent tests](/docs/v2/agent/testing) fast, free, and repeatable.

## Switching at runtime

The config sets the default. In the TUI, `*` opens the model palette — switch models or
providers mid-session without touching the agent. See [Models](/docs/v2/tui/models).

## Reference

Options and model lists for each engine:
[Axon()](/docs/v2/agent/engines/axon-cloud) ·
[Codex()](/docs/v2/agent/engines/codex) ·
[Cerebras()](/docs/v2/agent/engines/cerebras) ·
[Ollama()](/docs/v2/agent/engines/ollama) ·
[OpenRouter()](/docs/v2/agent/engines/openrouter) ·
[Mock()](/docs/v2/agent/engines/mock)

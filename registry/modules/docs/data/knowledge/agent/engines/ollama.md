---
title: Ollama
---

# Ollama

Local inference on your machine. No API costs, no data leaving your machine. Requires
[Ollama](https://ollama.com) installed — Axon manages the server lifecycle automatically.

## Configuration

```ts
import { Ollama } from "@arcforge/engines"

export default defineAgent({
    engine: Ollama({ model: "qwen2.5:7b" }),
})
```

`model` is the model name as it appears in `ollama list`. Any model you've pulled is
valid.

With a custom host:

```ts
import { Ollama } from "@arcforge/engines"

export default defineAgent({
    engine: Ollama({
        model: "qwen2.5:7b",
        host: "http://localhost:11434",  // default
    }),
})
```

## Installing models

Open the model palette with `*`. Ollama models are listed and filtered to your hardware,
labelled by fit — recommended, possible, or unlikely to run well. Select any model to
start downloading. Once complete it's available immediately.

Or pull directly:

```bash
ollama pull qwen2.5:7b
```

## Managing running models

```bash
:ollama ps        # show models currently loaded in VRAM
:ollama unload    # unload a model from VRAM
:ollama remove    # delete a model from disk
:ollama update    # re-pull all installed models to latest
:ollama stop      # stop the Ollama server
```

## Switching models at runtime

Open the model palette with `*` and select any pulled model. The change takes effect
for the next session.

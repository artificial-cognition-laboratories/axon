---
title: Ollama
---

# Ollama

Run models on your own hardware. No API costs, nothing leaving your machine. Requires
[Ollama](https://ollama.com) installed — Axon manages the server automatically once it is.

Open the model palette (`*`) and browse the Ollama library. Models are filtered to your
hardware and labelled by fit — recommended, possible, or unlikely to run well. Select one
and it starts downloading immediately.

::TerminalImage{src="/tui/axonmodelpaletteopenshowingdownloadinglocalmodel.webp" alt="TUI model palette on the local tab showing an Ollama model downloading"}
::

Manage running models from within the TUI:

```bash
:ollama ps              # show models currently loaded in VRAM
:ollama unload          # unload a model from VRAM
:ollama remove          # delete a model from disk
:ollama update          # re-pull all installed models to latest
:ollama stop            # stop the Ollama server
```

Nothing to store, nothing to send — the models live on your disk and run in your VRAM.
Check what else is configured any time:

```bash
:keys show
```

Running? [Your First Agent](/docs/v2/getting-started/first-agent) is next.

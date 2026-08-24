---
title: OpenAI Codex
---

# OpenAI Codex

Already paying for a Codex subscription? Connect it via OAuth — no API key, no extra cost.
Axon routes to it and takes nothing; you're billed by OpenAI exactly as you already are.

```bash
:keys set openai connect
```

This opens a browser window for authentication. Once approved, Codex models appear in the
model palette. The connection auto-refreshes — you won't need to reconnect unless you
explicitly disconnect.

::TerminalImage{src="/tui/axonmodelpaletteopencodextab.webp" alt="TUI model palette on the OpenAI tab showing Codex models"}
::

```bash
:keys set openai reconnect
:keys set openai disconnect
```

Keys are stored locally in `~/.axon/` and never sent to Axon servers. Check what's
configured any time:

```bash
:keys show
```

Connected? [Your First Agent](/docs/v2/getting-started/first-agent) is next.

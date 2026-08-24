---
title: OpenRouter
---

# OpenRouter

Access 100+ models with your own OpenRouter key. Costs go direct to OpenRouter at their
rates — no Axon markup, nothing on your Axon balance.

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys), then in the TUI:

```bash
:keys set openrouter
```

Enter your key when prompted. All OpenRouter models appear in the model palette
immediately.

::TerminalImage{src="/tui/axontuimodelpaletteopenopenroutertabactive.webp" alt="TUI model palette showing OpenRouter models"}
::

Keys are stored locally in `~/.axon/` and never sent to Axon servers. Check what's
configured any time:

```bash
:keys show
```

Connected? [Your First Agent](/docs/v2/getting-started/first-agent) is next.

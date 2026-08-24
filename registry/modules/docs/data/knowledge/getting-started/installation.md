---
title: Installation
---

# Installation

::InstallCommand
::

Installs Bun (if not already present) and Axon. Safe to re-run.

```bash
axon
```

::TerminalImage{src="/tui/axontuiemptychatwindowcleanlanding.webp" alt="Axon TUI boot screen showing the Axon logo, agent name, model, thread ID, and tool count"}
::

## Authenticate

On first boot you'll be prompted to authenticate. Follow the link in your terminal,
create an account, and enter the code shown in the TUI.

::TerminalImage{src="/tui/axontuiawaitingdeviceaprovalstate.webp" alt="Axon TUI showing the device authorization flow with a code and URL to complete in the browser"}
::

That's it — you're live. Your account comes with free credits, so Axon Cloud is active
the moment you sign in. No card, no config. Press `*`, pick a model, and start talking to
an agent right now.

## Powering your agent

Every agent needs a brain. Axon doesn't lock you into one — the free credits get you
started, and when they run low you have options. Axon never sits between you and your
inference; the Axon balance is only ever for Axon's own services (the managed `Axon()`
provider, deployments, voice). Bring your own model and you may never touch billing at all.

- [**Axon Cloud**](/docs/v2/providers/axon-cloud) — zero setup, works instantly. Free
  credits now, top up when you're ready.
- [**OpenAI Codex**](/docs/v2/providers/codex) — already pay for a Codex subscription?
  Connect it. Axon takes nothing.
- [**OpenRouter**](/docs/v2/providers/openrouter) — your own key, 100+ models, provider
  rates with no markup.
- [**Ollama**](/docs/v2/providers/ollama) — run models on your own hardware. No API costs,
  nothing leaves your machine.

Already logged in and happy on Cloud credits? Skip straight to
[Your First Agent](/docs/v2/getting-started/first-agent).

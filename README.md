# Axon

An agent runtime for people who want agents in production — not a framework to build one from scratch.

You write what only you can write: what the agent knows, what it can do, and how it behaves. Axon handles the rest — the cognitive loop, context assembly, tool dispatch, session persistence, and policy enforcement.

```bash
npm install -g @arcforge/axon
axon init my-agent && cd my-agent
axon                  # interactive TUI
axon dev              # local dev server
axon deploy           # live service, public URL, managed infra
```

An agent is a folder in your repo:

```
my-agent/
├── axon.config.ts    # identity, engine, policy
├── src/              # boot prompt, tools, scripts
├── modules/          # installed capabilities
└── data/             # durable storage and knowledge
```

Run it locally, headless, or in the cloud — same folder, same code, no environment-specific config.

## Modules

This repository contains the official Axon modules — installable capability packages that extend what an agent can do:

```bash
axon install @axon/github
axon install @axon/discord
axon install @axon/linear
```

Available modules: `arxiv` `discord` `github` `google` `kanban` `lsp` `obsidian` `spec` `telegram` `weather`

Each module contributes typed tool namespaces, prompts, and scripts. They operate within the agent's declared policy — no module can exceed what the base agent is allowed to do.

## Links

- [Documentation](https://axon.arclabs.it/docs) — full reference, guides, and examples
- [Discord](https://discord.gg/Xs74DhvTjr) — questions, feedback, and the community

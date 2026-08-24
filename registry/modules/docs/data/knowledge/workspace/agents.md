---
title: agents/
---

# agents/

All agents live at `~/.axon/agents/`. Each subfolder is a self-contained agent — a standard Bun TypeScript project with the structure Axon knows how to read.

```bash
~/.axon/agents/
├── default/
│   ├── data/
│   ├── modules/
│   ├── server/
│   ├── src/
│   │   ├── prompts/
│   │   ├── scripts/
│   │   ├── tools/
│   │   └── boot.vue
│   ├── .env
│   ├── axon.config.ts
│   ├── package.json
│   └── tsconfig.json
└── my-agent/
    └── ...
```

## The default agent

Axon ships with an agent pre-populated at `agents/default/`. Running `axon` opens it. It has `@axon/fs` and `@axon/fetch` pre-installed and sensible env passthrough for development use.

It is a regular agent. The name `default` is just the folder name — nothing in the runtime treats it specially. Edit it, install modules into it, or ignore it entirely and create your own.

## Creating an agent

```bash
axon init my-agent
```

Scaffolds `~/.axon/agents/my-agent/` with `axon.config.ts`, `.env`, `package.json`, `tsconfig.json`, and empty `src/`, `server/`, and `data/` directories. No tools pre-installed.

Open it with:

```bash
axon --agent my-agent
```

## Installing modules into an agent

```bash
axon install @axon/github              # install into the active agent
axon install @axon/github --agent my-agent  # install into a specific agent
```

Installing copies module source into `modules/`, merges npm dependencies into `package.json`, and runs `bun install`. Nested module dependencies are resolved automatically.

## Publishing an agent to the registry

```bash
axon publish
```

Packages `axon.config.ts`, `src/`, `package.json`, and `axon.manifest.json` and uploads to the registry. Excludes `.env`, `node_modules/`, and generated files.

Someone who installs a published agent gets a complete folder. They open it with `axon --agent <name>` and add the env keys declared in `env.needs` to their `.env`.

See [Publishing agents](/docs/v2/agents/publishing) for what is included and excluded.

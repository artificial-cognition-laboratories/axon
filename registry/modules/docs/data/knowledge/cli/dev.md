---
title: axon dev
---

# axon dev

Boot the agent locally with hot reload.

```bash
axon dev
axon dev --port 3141
```

Run from your agent directory. Axon prepares the manifest, boots the agent, and prints
the WebSocket URL. Source changes hot-reload into the running session when Axon can
preserve the runtime boundary safely.

## Output

```bash
✓ prepare 12ms
✓ boot 340ms

my-agent
  ├─ routes (2)
  │   ├─ POST /api/chat
  │   └─ POST /api/scout
  ├─ tools (5)
  └─ scripts (3)

➜ Runtime: ws://localhost:3141/ws
```

The manifest tree shows everything the agent registered at boot — routes, tools, and
scripts. If something is missing, it didn't load.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3141` | WebSocket port to listen on |

## Hot reload

Watches `src/`, `.env`, and `package.json`. Tools, prompts, scripts, boot context, and
environment changes reload into the running agent for future turns. Runtime boundary
changes, such as server routes or config, require a restart.

For the full reload model, see [Hot Reload](/docs/v2/concepts/hot-reload).

## Shutdown

`Ctrl+C` once for graceful shutdown. `Ctrl+C` twice to force exit.

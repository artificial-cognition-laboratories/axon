---
title: Connecting to Your Agent
---

# Connecting to Your Agent

Once deployed, your agent is accessible three ways: the TUI, HTTP, and WebSocket.

## TUI

Open Axon — your deployed agents appear alongside your local ones. Select one to connect.

```bash
axon
```

The TUI fetches your deployments automatically. Sessions, thread history, and the command
palette all work identically against a deployed agent.

## HTTP

Every route you defined in `server/api/` is available at your agent's public URL.
Authenticate with your API key.

```bash
# Chat — built-in route, available on every deployed agent
curl -X POST https://<your-agent-url>/api/chat \
  -H "Authorization: Bearer axon_..." \
  -H "Content-Type: application/json" \
  -d '{ "message": "summarise my open issues" }'

# Any custom route you defined
curl -X POST https://<your-agent-url>/api/scout \
  -H "Authorization: Bearer axon_..."
```

Routes that call `axon.stream()` return a streaming response. Consume it as
Server-Sent Events or a chunked transfer.

## WebSocket

For persistent connections and real-time streaming, connect directly to the thread
WebSocket:

```bash
wscat -c wss://<your-agent-url>/thread \
  -H "Authorization: Bearer axon_..."
```

The thread protocol is the same protocol the TUI uses. Send messages, receive streamed
entries as they are produced.

## Finding your URL and key

```bash
axon status         # prints the URL for the current agent deployment
```

Both are also printed on first deploy and available in the dashboard.

---
title: server/
icon: vscode-icons:folder-type-server
---

# server/

The `server/` folder adds an HTTP layer to your agent. Three subdirectories, each with a
distinct role:

```bash
server/
├── api/          # HTTP routes
├── middleware/   # per-request handlers
└── plugins/      # boot-time initialization
```

The server is optional. An agent without a `server/` folder runs fine — it just has no
HTTP surface. Add `server/` when you need to expose the agent over HTTP, receive webhooks,
or run setup code at boot.

## Boot sequence

When the agent starts:

1. `axon.config.ts` loaded — identity, engine, policy, env
2. `src/` scanned — tools, prompts, scripts indexed
3. `modules/` loaded — their contributions merged in
4. `server/plugins/` run — connections established, hooks registered
5. HTTP server ready — routes in `server/api/` accepting requests

Plugins run before the server accepts requests. This guarantees that anything a plugin
sets up — database connections, hook subscriptions, SDK clients — is ready before the
first route fires.

## No implicit invocation

Routes do not invoke the agent automatically. An HTTP request arrives, your handler runs,
and if you want the agent involved you call `axon.request()` or `axon.stream()`. When you
do, the runtime takes over — context assembly, the cognitive loop, tool dispatch, stop
conditions. You get back a result or a stream.

```ts
// This route never touches the agent
export default defineEventHandler(() => {
    return { ok: true }
})

// This route invokes the agent
export default defineEventHandler(async event => {
    const prompt = await axon.prompt("triage", await readBody(event))
    return axon.stream({ prompt })
})
```

The agent is a capability your routes reach for — not something that runs on every request.

## Authentication

Deployed routes require a valid API key by default:

```
Authorization: Bearer axon_...
```

To make a route public:

```ts
export const routeMeta = { auth: false }

export default defineEventHandler(async event => {
    // verify third-party signature here before using the payload
    return { ok: true }
})
```

Public routes should always verify their own signatures or tokens. Webhooks from GitHub,
Stripe, Linear, etc. include HMAC signatures for exactly this purpose.

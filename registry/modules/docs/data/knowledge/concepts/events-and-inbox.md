---
title: Routes & Hooks
---

# Routes & Hooks

Scripts handle outbound work — you invoke them, they run, they finish. Routes and hooks
handle inbound work — the outside world triggers your agent.

The pattern is always the same: something external happens, a route receives it, the agent
is invoked with context about what happened.

## Routes

`server/api/` is the complete inbound surface. File-based routing maps filenames to HTTP
paths and methods.

```bash
server/api/
├── webhooks/
│   └── github.post.ts   → POST /api/webhooks/github
├── chat.post.ts         → POST /api/chat
└── status.get.ts        → GET /api/status
```

Routes are standard h3 handlers. They receive a request, do whatever work is needed, and
return a response. Invoking the agent is one option — not automatic.

```ts
// server/api/webhooks/github.post.ts
export default defineEventHandler(async event => {
    const payload = await readBody(event)

    if (payload.action !== "opened") return { ignored: true }

    const prompt = await axon.prompt("issue-triage", {
        number: payload.issue.number,
        title: payload.issue.title,
        body: payload.issue.body,
    })

    // fire and forget — respond immediately, agent works asynchronously
    void axon.request({ prompt })

    return { received: true }
})
```

The route hands the agent everything it needs in the prompt. A webhook is an external
fact, not a conversation — the issue's content belongs in the prompt, and the agent's
reasoning about it belongs in the session.

## Hooks

Hooks decouple event emission from event handling. A module emits a named hook when
something happens. Your code subscribes to that hook in a plugin. The module doesn't know
who's listening — it just fires the event.

```ts
// @axon/github module — emits a hook when an issue opens
await axon.hooks.callHook("github:issue.opened", { number, title, labels, body })
```

```ts
// server/plugins/triage.ts — your agent subscribes
export default defineAxonPlugin(async axon => {
    axon.hooks.hook("github:issue.opened", async ({ number, title, body }) => {
        const prompt = await axon.prompt("issue-triage", { number, title, body })
        void axon.request({ prompt })
    })
})
```

This is how module integrations work. The module ships the webhook route and emits the
hook. You subscribe in your plugin and decide what the agent does with it.

## Plugins

Plugins run at boot and have access to the full `axon` API. They're the right place for
hook subscriptions, event listeners, and any setup that needs to happen once before the
server starts handling requests.

```ts
// server/plugins/setup.ts
export default defineAxonPlugin(async axon => {
    // subscribe to module hooks
    axon.hooks.hook("linear:issue.created", async ({ id, title }) => {
        const prompt = await axon.prompt("triage", { id, title })
        void axon.request({ prompt })
    })

    // subscribe to platform hooks
    axon.hooks.hook("email:received", async ({ from, subject, body }) => {
        const prompt = await axon.prompt("email-process", { from, subject, body })
        void axon.request({ prompt })
    })
})
```

## Platform hooks

These are emitted by the Axon runtime itself — no module required.

| Hook | When |
|---|---|
| `boot` | Agent is starting |
| `shutdown` | Agent is stopping |
| `server:ready` | HTTP server is listening |
| `email:received` | Inbound email arrived |

Every deployed agent gets its own email address. The `email:received`
hook fires automatically. Subscribe to it in a plugin to make your agent respond to email
without installing anything.

## Fire and forget

When a route needs to acknowledge receipt immediately and let the agent work in the
background, void the invocation and return early:

```ts
void axon.request({ prompt })
return { received: true }
```

The route returns before the loop completes. The caller gets an immediate response. The
agent runs to completion in the background, and its work lands in the session trace.

Use this for webhooks and any integration where the caller has a short timeout. Don't use
it when the caller needs the agent's response to construct their own response — use
`axon.stream()` and pipe the entries instead.

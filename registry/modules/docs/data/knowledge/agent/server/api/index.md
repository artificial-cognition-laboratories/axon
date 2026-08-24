---
title: api/
icon: vscode-icons:folder-type-api
---

# server/api/

File-based routing. Filename maps to path. HTTP method is encoded in the filename suffix.

```bash
server/api/
├── webhooks/
│   └── github.post.ts   → POST /api/webhooks/github
├── chat.post.ts         → POST /api/chat
├── health.get.ts        → GET  /api/health
└── scout.post.ts        → POST /api/scout
```

Append `.get`, `.post`, `.put`, `.patch`, or `.delete` before `.ts`. No suffix accepts
any method.

## Calling the agent

Routes don't invoke the agent automatically. Use `axon.request()` for a complete result,
or `axon.stream()` to pipe entries as they arrive.

```ts
// server/api/scout.post.ts
export default defineEventHandler(() => {
    const { stream } = axon.scripts.stream("scout")
    return stream
})
```

```ts
// server/api/review.post.ts
export default defineEventHandler(async event => {
    const { issueId } = await readBody(event)
    const prompt = await axon.prompt("code-review", { issueId })
    return axon.stream({ prompt })
})
```

Scripts are the primary unit — most routes are thin wrappers that call a script and return
the stream. Put logic in the script, not the route.

## Fire and forget

When a route needs to acknowledge receipt immediately and let the agent work in the
background:

```ts
// server/api/webhooks/github.post.ts
export default defineEventHandler(async event => {
    const payload = await readBody(event)
    if (payload.action !== "opened") return { ignored: true }

    const prompt = await axon.prompt("issue-triage", {
        number: payload.issue.number,
        title: payload.issue.title,
    })

    void axon.request({ prompt })
    return { received: true }
})
```

`void` fires the invocation without awaiting it. The route returns immediately. Use this
for webhooks where the caller has a short timeout.

## Routes that don't invoke the agent

Normal HTTP endpoints return without calling the agent at all:

```ts
// server/api/health.get.ts
export default defineEventHandler(() => ({ ok: true }))
```

## Standard routes

Every deployed agent has these built in:

| Route | What it does |
|---|---|
| `POST /api/chat` | Default chat — override by creating `server/api/chat.post.ts` |
| `GET /api/health` | Health check — returns `{ ok: true }` |
| `GET /api/info` | Agent metadata — name, version, engine |

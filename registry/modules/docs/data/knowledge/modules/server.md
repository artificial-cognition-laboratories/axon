---
title: server/
---

# server/

Route and plugin contributions. Modules that integrate external services ship their
HTTP surface here — the agent author gets a working webhook receiver without writing
verification or normalization code.

## server/api/

Files in `server/api/` are mounted on the parent agent's HTTP server at `/api/*`.
The naming convention follows the same pattern as agent routes:

```bash
server/api/github.post.ts    # → POST /api/github
server/api/stripe.post.ts    # → POST /api/stripe
```

The canonical pattern for a connector route: verify the inbound payload, normalize
it, emit a hook. Nothing else.

```ts
// server/api/github.post.ts
export default defineEventHandler(async (event) => {
    const rawBody = (await readRawBody(event)) ?? ""
    const sig = getRequestHeader(event, "x-hub-signature-256") ?? ""

    if (!verifySignature(rawBody, sig, process.env.GITHUB_WEBHOOK_SECRET!)) {
        throw createError({ statusCode: 403, message: "invalid signature" })
    }

    const payload = JSON.parse(rawBody)

    await axon.callHook("github:issue.opened", {
        number: payload.issue.number,
        title: payload.issue.title,
        labels: payload.issue.labels.map((l: any) => l.name),
    })

    return { ok: true }
})
```

The module handles verification. The agent author handles what happens when the hook
fires — they subscribe in their own plugin.

## server/plugins/

Plugin files run at agent boot, before routes are mounted. Use for setup that routes
or hooks depend on — database connections, SDK initialization, anything that needs to
be ready before requests arrive.

Module plugins run before user plugins. That ordering guarantee means a module can
establish a connection in its plugin and the agent author can use it in theirs.

```ts
// server/plugins/db.ts
export default defineAxonPlugin(async (axon) => {
    const db = await connectDatabase(process.env.DATABASE_URL!)
    axon.provide("db", db)

    axon.hooks.hook("axon:agent:shutdown", () => db.close())
})
```

## What the boundary is

Module routes are registered through the module system and mounted by Axon — not
injected by arbitrary file mutation. The parent agent still owns top-level policy,
auth middleware, and behavior routing.

A module contributes the route. Axon decides how it is mounted. The agent author
decides what the hook does.

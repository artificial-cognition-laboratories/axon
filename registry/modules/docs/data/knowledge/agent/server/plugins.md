---
title: plugins/
icon: vscode-icons:folder-type-plugin
---

# server/plugins/

Plugins run once at boot, before the HTTP server accepts requests. Use them for
initialization: database connections, SDK clients, hook subscriptions, shutdown cleanup.

Files load in filename order. If order matters, use numeric prefixes:

```bash
server/plugins/
├── 01-database.ts
├── 02-cache.ts
└── github.ts
```

## Defining a plugin

```ts
// server/plugins/database.ts
export default defineAxonPlugin(async axon => {
    const db = await connectDb(process.env.DATABASE_URL)

    axon.hooks.hook("shutdown", async () => db.close())

    globalThis.db = db
})
```

`defineAxonPlugin` receives the live `axon` handle. Use it to initialize connections,
register hook handlers, and set up globals that routes can use.

A plugin that throws aborts boot entirely — the server never starts. This ensures the
agent never runs in a partially-initialized state.

## Hook subscriptions

Plugins are the right place to subscribe to module hooks. When a module emits a named
hook from a route, you wire the response here:

```ts
// server/plugins/integrations.ts
export default defineAxonPlugin(async axon => {
    axon.hooks.hook("github:pr.opened", async ({ number, title }) => {
        const prompt = await axon.prompt("pr-review", { number, title })
        void axon.request({ prompt })
    })

    axon.hooks.hook("linear:issue.created", async ({ id, title }) => {
        const prompt = await axon.prompt("triage", { id, title })
        void axon.request({ prompt })
    })
})
```

## Lifecycle hooks

```ts
axon.hooks.hook("boot", () => { ... })          // after plugins, before server ready
axon.hooks.hook("server:ready", () => { ... })  // HTTP server is listening
axon.hooks.hook("server:close", () => { ... }) // server stopped accepting requests
axon.hooks.hook("shutdown", async () => { ... }) // final cleanup
```

Use `"shutdown"` for cleanup — closing database connections, flushing queues, graceful
termination of background processes.

## Boot order

Module plugins run before user plugins. This guarantees modules can set up dependencies — SDK clients, event emitters — before your code subscribes to them.

Order: module plugins → user plugins → `boot` hook → HTTP server ready → `server:ready` hook.

---
title: server
---

# server

Configures the agent's HTTP server. Only relevant when the agent runs with a
server — `axon dev`, `axon deploy`, or `Axon({ server: { port } })`.

```ts
export default defineAgent({
    server: {
        auth: "axon",
    },
})
```

## auth

Controls who can call the agent's HTTP endpoints.

| Value | Behaviour |
|-------|-----------|
| `"axon"` | Enforce Axon Cloud JWT. Requires `AXON_JWT_PUBLIC_KEY` in env. |
| `false` | Disable auth entirely. All routes are public. |
| `function` | Custom handler. Throw a 401 error to reject. |

When omitted, the runtime auto-detects: if `AXON_JWT_PUBLIC_KEY` is set, JWT
auth is enforced. If not set, all routes are open — useful for local dev without
extra setup.

```ts
// Custom auth handler
server: {
    auth: async (event) => {
        const token = getHeader(event, "x-api-key")
        if (token !== process.env.MY_API_KEY) {
            throw createError({ status: 401 })
        }
    },
}
```

The custom handler receives an H3 event. Throw to reject, return normally to
allow. Any H3 utility (`getHeader`, `getCookie`, etc.) works inside it.

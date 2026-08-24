---
title: middleware/
icon: vscode-icons:file-type-typescript
---

# server/middleware/

Middleware files run on every HTTP request before your route handlers. Use them for cross-cutting concerns: logging, cors, rate limiting, request timing, auth checks that apply globally.

Files in `server/middleware/` are loaded in filename order and run before every request.

## Defining middleware

```ts
// server/middleware/logging.ts
export default defineEventHandler(event => {
    const start = Date.now()
    console.log(`→ ${event.method} ${event.path}`)

    // Attach timing header on response
    event.node.res.on("finish", () => {
        console.log(`← ${event.method} ${event.path} ${Date.now() - start}ms`)
    })
})
```

Middleware receives the event and can:

- Return nothing to pass through to the next handler
- Throw a `createError` to short-circuit and return an error response

## Order of execution

```ts
"request → middleware/a.ts → middleware/b.ts → route handler"
```

If you need specific ordering, prefix filenames with numbers:

```ts
"server/middleware/01-logging.ts"
"server/middleware/02-cors.ts"
"server/middleware/99-timing.ts"
```

## Practical examples

### CORS

```ts
// server/middleware/cors.ts
import { defineEventHandler, setHeader } from "h3"

export default defineEventHandler(event => {
    setHeader(event, "Access-Control-Allow-Origin", "*")
    setHeader(event, "Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    setHeader(event, "Access-Control-Allow-Headers", "Content-Type, Authorization")
})
```

### Rate limiting

```ts
// server/middleware/rate-limit.ts
import { defineEventHandler, createError } from "h3"

const requests = new Map<string, number[]>() // ip → [timestamps]

export default defineEventHandler(event => {
    const ip = event.node.req.socket.remoteAddress ?? "unknown"
    const now = Date.now()
    const window = 60000 // 1 minute
    const limit = 60 // requests per minute

    const timestamps = requests.get(ip) ?? []
    const recent = timestamps.filter(t => now - t < window)

    if (recent.length >= limit) {
        throw createError({ statusCode: 429, message: "rate limit exceeded" })
    }

    recent.push(now)
    requests.set(ip, recent)
})
```

### Request validation

```ts
// server/middleware/api-key.ts
import { defineEventHandler, getRequestHeader, createError } from "h3"

export default defineEventHandler(event => {
    const key = getRequestHeader(event, "x-api-key")
    if (!key || !key.startsWith("axon_")) {
        throw createError({ statusCode: 401, message: "invalid api key" })
    }
})
```

Note: Deployed routes already require auth by default. Use middleware for additional checks, not for the default auth.

## What middleware cannot do

- Middleware cannot modify the response body after the handler runs.
- For async initialization (connecting to services), use [plugins](/docs/v2/agent/server/plugins) instead — plugins run once at boot, middleware runs on every request.


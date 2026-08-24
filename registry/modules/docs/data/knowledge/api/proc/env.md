---
title: process.env
---

# process.env

The capsule subprocess inherits the agent's environment. `process.env` contains every
key declared in the agent's `.env` file and resolved through `axon.config.ts` env
configuration — available immediately, no imports required.

```ts
const token = process.env.GITHUB_TOKEN
const apiUrl = process.env.API_BASE_URL
```

## What's in it

Keys come from three sources, in this order of precedence:

1. **`.env`** — agent-local secrets. Never committed, never published.
2. **`env.pass`** in `axon.config.ts` — keys from the host machine's environment
   explicitly passed into the capsule.
3. **`env.set`** in `axon.config.ts` — static values baked into the config.

The capsule does not inherit the full host environment by default. Only keys declared
in `env.pass` are forwarded. This is intentional — it prevents accidental leakage of
host secrets into the agent.

## Declaring required keys

```ts
// axon.config.ts
export default defineAgent({
    env: {
        needs: ["GITHUB_TOKEN", "LINEAR_API_KEY"],  // documented as required
        pass: ["HOME", "PATH"],                      // forwarded from host
        set: { NODE_ENV: "production" },             // static values
    },
})
```

`needs` is documentation — it tells `axon dev` what to warn about if missing, and
what gets listed when someone installs a published agent. It does not enforce presence
at runtime.

## In cloud deployments

Environment values from the agent project's `.env` are injected as environment variables
at runtime. They appear in `process.env` exactly as local `.env` keys do — the agent
source is identical between local and deployed. Values are not included in the
published source artifact or shown in deployment logs.

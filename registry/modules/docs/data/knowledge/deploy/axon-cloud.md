---
title: Axon Cloud
---

# Axon Cloud

One command. Your agent gets a public URL, an API key, and durable storage. No
Dockerfile, no infra config, no container registry.

```bash
axon login      # once
axon deploy
```

First deploy prints:

```bash
Deployed: https://<your-agent-url>
API key:  axon_...
```

Subsequent deploys update the running agent in place.

## Environment keys travel with the agent

Your agent's `.env` is the source of truth for its keys — and deployment doesn't change
that. The keys in the agent folder ship with the deployment; the agent reads them from
its environment in the cloud exactly as it did locally. No separate secrets dashboard,
no re-declaring variables per environment.

Giving an agent a key is one explicit act: put it in the agent's `.env`. See
[Environment & Secrets](/docs/v2/agent/environment).

## What changes in the cloud

The agent source is identical. The runtime is different:

- **No TUI** — your agent is accessed over HTTP via the routes in `server/api/`
- **Isolated runtime** — runs in a container with no access to your local machine
- **Durable data** — `data/` is backed by cloud storage, persists across restarts and redeploys
- **Email address** — every deployed agent gets its own email address

## Calling your agent

The default `POST /api/chat` route is built-in:

```bash
curl -X POST https://<your-agent-url>/api/chat \
  -H "Authorization: Bearer axon_..." \
  -H "Content-Type: application/json" \
  -d '{ "message": "summarise my open issues" }'
```

Any route you defined in `server/api/` is available at the same base URL.

## Managing

```bash
axon status                 # is it running
axon logs                   # tail live logs
axon undeploy --yes         # tear it down
```

## Runtime config

All deployment config lives in `axon.config.ts` under `deploy` and `connections`.

### Scaling

```ts
export default defineAgent({
    deploy: {
        scaling: {
            min: 0,   // scale to zero when idle (default)
            max: 3,   // max concurrent instances (default)
        },
    },
})
```

`min: 0` means the agent shuts down when idle and cold-starts on the next request.
Set `min: 1` to keep an instance warm if cold-start latency matters for your use case.
`max` caps concurrent instances — useful for agents that hold external connections or
have per-instance rate limits.

### System packages

The container runs Alpine Linux with Bun and standard Unix tools. Add extras:

```ts
export default defineAgent({
    deploy: {
        runtime: {
            packages: ["git", "ripgrep", "ffmpeg"],
        },
    },
})
```

Packages are installed via `apk` at build time. Anything available in the Alpine package
registry can go here.

### Scheduled triggers

Axon provisions Cloud Scheduler jobs for you. Declare schedules in `connections`:

```ts
export default defineAgent({
    connections: {
        schedule: [
            {
                name: "daily-digest",
                cron: "0 9 * * *",        // 9am UTC daily
                timezone: "Europe/London",
            },
            {
                name: "hourly-sync",
                cron: "0 * * * *",
            },
        ],
    },
})
```

Each schedule fires a `POST` to `/_axon/inbox/{name}` on your agent. Handle it in
`server/api/`:

```ts
// server/api/_axon/inbox/daily-digest.post.ts
export default defineEventHandler(async () => {
    const { stream } = axon.scripts.stream("daily-digest")
    return stream
})
```

Schedules are created and updated on every `axon deploy`. Deleting an entry removes the
Cloud Scheduler job on next deploy.

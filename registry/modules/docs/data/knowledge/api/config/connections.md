---
title: connections
---

# connections

Declares external triggers that invoke the agent. Currently supports cron schedules.

## schedule

Axon provisions a Cloud Scheduler job for each entry. At the specified time, the
platform sends a POST to `/_axon/inbox/{name}` on your deployed agent.

```ts
export default defineAgent({
    connections: {
        schedule: [
            {
                name: "daily-digest",
                cron: "0 9 * * *",        // 9am UTC daily
                timezone: "Europe/London", // optional, defaults to UTC
            },
            {
                name: "hourly-check",
                cron: "0 * * * *",
            },
        ],
    },
})
```

The agent receives the schedule trigger as a standard inbox request. Handle it
in a server route:

```ts
// server/api/_axon/inbox/daily-digest.post.ts
export default defineEventHandler(async () => {
    const { stream } = axon.scripts.stream("run-digest")
    for await (const _ of stream) {}
})
```

`name` must be unique within the agent. It becomes the inbox route path and the
Cloud Scheduler job name — no spaces, no special characters.

Schedules only apply when `deploy.target` is `"axon"`. They are ignored when
running locally with `axon dev`.

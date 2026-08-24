---
title: Deploy
---

# Deploy

`axon deploy`. A stable production URL. An API key. Durable storage. No Dockerfile, no
infra config, no deployment branch. The same folder that ran in your terminal is now a
live cloud service.

A deployed agent is the same folder you ran locally, hosted as a service. The source
doesn't change. The interface does — no TUI, just the HTTP routes you defined in
`server/api/`, plus the built-in ones.

## Axon Cloud

One command. Managed infrastructure, isolated container, durable `data/`, and the TUI
connects to it from anywhere you're logged in.

```bash
axon deploy
```

[Axon Cloud →](/docs/v2/deploy/axon-cloud)

## Your agent is never locked in

The agent is a folder — not a feature of our infrastructure. `axon build` produces a
standard container image from it:

```bash
axon build
# → .agent/image.tar
```

That image runs anywhere containers run. If our hosting isn't the best place for your
agent, you can take it elsewhere — and that's deliberate. Axon Cloud has to earn the
deployment by being the easiest and best-run home for it, not by holding your agent
hostage.

Today, self-hosting is a build artifact and a container platform of your choice —
first-class support, with tested provider guides and tooling, is coming. Axon Cloud is
the path we've built, refined, and stand behind.

---

[Axon Cloud →](/docs/v2/deploy/axon-cloud) &nbsp;&nbsp; [Connecting →](/docs/v2/deploy/connecting)

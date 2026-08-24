---
title: axon deploy
---

# axon deploy

Deploy the agent project at the current directory to Axon Cloud. `axon deploy`
is a project command: Axon identifies the project from the working directory,
then requires that it is an agent because only agents can run as deployments.
It is not nested under an agent subcommand.

```bash
axon deploy
```

Builds the agent, pushes it to Axon's infrastructure, and returns a public URL and API
key. Requires `axon login`.

On first deploy:

```bash
Deployed: https://<your-agent-url>
API key:  axon_...
```

Subsequent deploys replace the running revision in the same deployment slot;
they do not create another cloud deployment for the agent.

## What changes in the cloud

The agent source is identical. The runtime environment changes:

- No TUI — the agent is accessed over HTTP using the server routes you defined
- Environment values are read from the agent project's `.env` at deploy time and are never included in source
- Durable data persisted to GCS — `data/` is backed by cloud storage, survives restarts
- Isolated process — each agent runs in its own container

## Managing a deployed agent

```bash
axon status                 # inspect the deployment for this project
axon logs --follow          # follow live logs
axon undeploy --yes         # tear down the deployment
```

See [Axon Cloud](/docs/v2/deploy/axon-cloud) for the full deployment guide.

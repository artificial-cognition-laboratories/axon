---
title: axon build
---

# axon build

Build a deployable artifact from the current agent.

```bash
axon build
```

Produces a `.agent/` output folder containing:

| Output | What it is |
|---|---|
| `.agent/image.tar` | Docker image — deploy to any container host |
| `.agent/bundle.tar.gz` | Source tarball — for hosts that build from source |

The build bundles the agent source, installed modules, and resolved dependencies. The
`.env` file is excluded — secrets are injected at runtime by the host.

`axon build` is the foundation for self-hosting. The output runs identically to an Axon
Cloud deployment. See [Deploy](/docs/v2/deploy) for the self-host story.

For one-command cloud deployment, use [`axon deploy`](/docs/v2/cli/deploy) instead.

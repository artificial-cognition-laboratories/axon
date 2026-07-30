# axon-base

Base Docker image for deployed Axon agents. All agent images extend this.

## What this image does

Boots an Axon agent from a directory using `@axon/runtime`. The entrypoint (`/axon/boot.ts`) reads environment variables, validates that `axon.config.ts` exists, calls `Axon()`, and handles SIGTERM for clean shutdown.

## Environment variables

| Variable     | Default      | Description                                       |
| ------------ | ------------ | ------------------------------------------------- |
| `AGENT_ROOT` | `/agent`     | Path to the agent directory inside the container. |
| `PORT`       | `8080`       | HTTP port the runtime listens on.                 |
| `AXON_ENV`   | `production` | Runtime environment label (read by agent code).   |

## How agent images extend this base

```dockerfile
FROM axon-base:0.1.0

WORKDIR /agent
COPY . .
RUN bun install --production
```

The agent directory must contain `axon.config.ts`. If it is missing, the container exits immediately with a clear error message.

## Building

```sh
# Build locally with the latest tag
bun run build

# Build with the versioned tag (reads VERSION file)
bun run build:tag
```

## Versioning

The base image version lives in `VERSION`. Pin agent `FROM` directives to an explicit version — never `latest` — so agent deployments are reproducible and base image updates are deliberate.

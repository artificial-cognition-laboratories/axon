# Axon universal base image.
#
# One image for every deployed agent — the agent's SOURCE is delivered at boot
# (fetched from GCS by Hydrate, or mounted by the local staging pool), never
# baked in. Rebuild this image only when the RUNTIME changes, not per agent.
#
# The build context is the monorepo root. Rather than hand-listing workspace
# packages (which silently rots when the dependency graph changes — the exact
# bug that stranded the previous Dockerfile), we copy the whole libs/ tree and
# let Bun's workspace resolution assemble the graph.

FROM oven/bun:1.3-alpine

# tar is used by Hydrate to extract the fetched source tarball.
RUN apk add --no-cache tar

WORKDIR /axon

# Workspace manifest + lockfile first, so `bun install` layers cache on deps.
COPY package.json bun.lock ./

# The runtime and everything it resolves. libs/** is the workspace glob; the
# agent runtime (@axon/core), the blueprint scanner (@arcforge/axon), engines,
# capsule, cloud, types, and the boot entrypoint all live under it.
COPY libs/ ./libs/

# The root lockfile also records the apps/agents workspaces. The image-specific
# dockerignore includes only their package manifests, so Bun can validate the
# complete frozen workspace graph without copying their source into the image.
COPY apps/ ./apps/
COPY agents/ ./agents/

# Install only the deployed runtime's workspace closure. Installing every
# monorepo workspace would run unrelated application prepare scripts.
RUN bun install --filter @axon/docker --production --frozen-lockfile

ENV AGENT_ROOT=/agent
ENV PORT=8080
ENV AXON_ENV=production
# Agent source (delivered at boot) resolves @axon/* / @arcforge/* from the
# installed workspace node_modules.
ENV NODE_PATH=/axon/node_modules

EXPOSE 8080

# The thin entrypoint: reads the deploy env, runs the Boot orchestrator, serves.
CMD ["bun", "run", "/axon/libs/axon/packages/docker/boot.ts"]

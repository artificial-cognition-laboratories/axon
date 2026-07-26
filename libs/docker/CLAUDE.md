# @axon/docker — Deployed Agent Container

## What This Is

The universal base image and boot lifecycle for a **deployed** Axon agent. One
image (`axon-base`) serves every agent; the agent's **source** is delivered at
boot, never baked in. This package owns the container entrypoint and the
build/publish of the image. It is consumed by the backend provisioner
(`apps/backend/platform/gcloud`) which points Cloud Run (prod) or the local
staging ProcessPool (`MockDeployments`) at it.

A deployed agent is a distinct entity from the author's local agent: same
source, but its own instance, its own ephemeral sessions, its own persistent
endpoint. The two are never linked.

## The Design

**The invariant (non-negotiable): the runtime writes a native local filesystem
and is completely deployment-oblivious.** `Axon()` scans a folder and serves —
it never knows it is in a container. Every deployment concern lives in the
leaves around it, never inside the runtime.

```
boot.ts                  thin entrypoint: read env → Boot() → serve
Boot() (lifecycle.ts)    orchestrator, one path for prod AND staging
 ├─ Hydrate()            put source at AGENT_ROOT (fetch from GCS, or no-op if present)
 ├─ Blueprint() → Axon() scan the folder, boot the oblivious runtime
 └─ Serve()              bind the port, own SIGTERM/crash lifecycle
```

**Source delivery, not fuse.** `Hydrate` self-configures by context:
- **Staging** (ProcessPool): the pool extracts the tarball to a scratch dir and
  sets `AGENT_ROOT` to it → source already present → hydrate is a no-op.
- **Prod** (Cloud Run): `AGENT_ROOT` is empty; `AXON_SOURCE` (a `gs://` URI) is
  set → hydrate pulls the tarball from GCS via the metadata-server token (the
  runtime SA has read on the registry bucket) and extracts it. One-shot read.
  No gcsfuse mount anywhere.

The discriminator is simply "is there an `axon.config.ts` at AGENT_ROOT" — no
env flag, no "am I in the cloud" branch.

**Readiness is structural.** `Serve` binds the port only AFTER `Axon()` has
fully booted, so the moment the port accepts connections the agent is genuinely
ready. The Cloud Run startup probe hits `/_axon/health` on port 8080 — a route
the container actually serves. (The previous deploy failure was a probe
checking `/api/health:3000`, a path/port the container never answered.)

**Sessions are ephemeral.** A deployed agent boots with an EMPTY session dir and
the cognet builds fresh working state. Sessions are written to local native fs
and die with the box; they are NOT hydrated on boot and NOT restored. Persisting
memory across boots is a **userland** concern (the author connects a DB via a
plugin, writes consolidated state to `data/knowledge`, etc.) — the platform
makes no assumptions about what a cognet's state means, so it cannot own restore.

## Key Interfaces

- `boot.ts` — container entrypoint. Env: `AGENT_ROOT` (default `/agent`), `PORT`
  (default 8080), `AXON_SOURCE` (gs:// URI; prod only).
- `Boot({ agentRoot, port, source? })` — the lifecycle orchestrator. Returns
  `{ port, stop }`.
- `Hydrate({ agentRoot, source? })` — source delivery. `{ status: "present" | "fetched" }`.
- `Serve({ runtime, port })` — port binding + process lifecycle.
- `Dockerfile` — copies the whole `libs/` tree and installs the workspace graph
  (never hand-lists packages — that rot stranded the pre-rewrite Dockerfile).
- `deploy.ts` — builds/pushes `axon-base`, syncs `AXON_BASE_VERSION` in
  `apps/backend/platform/gcloud/deployments.ts`.

## The wire: /_axon/*

The agent server exposes a framework-reserved surface (`libs/axon/core/.../server/endpoints.ts`),
independent of user routes, that `AxonCloud.attach(url)` speaks to:
`GET /_axon/health`, `POST /_axon/request`, `POST /_axon/stream` (SSE). This is
what makes a deployed agent reachable through the same handle shape as a local one.

## Known Debt

- **`/_axon/*` is UNAUTHENTICATED (critical).** See `libs/axon/core/debt.md`. A
  deployed agent with public ingress is open to anyone with the URL. Hard gate
  before real deploy exposure: JWT (`AXON_CONNECT_TOKEN`) middleware in front of
  request/stream + a backend endpoint minting a scoped connect token.
- **Case-collision footgun:** the orchestrator is `lifecycle.ts`, not `Boot.ts`,
  because `boot.ts` importing `./Boot` silently resolved to the wrong module in
  Bun (module dies with no output). Do not reintroduce a `Boot.ts` beside `boot.ts`.
- **Session telemetry-out** (dashboard observability) is not built — sessions
  currently never leave the box. Optional one-way stream to a sink, if wanted.

---
title: Publishing
description: Ship a cognet to the registry — source, versions, and ABI compatibility.
---

# Publishing

Cognets are first-class registry artifacts. Same namespace as agents and modules, same
versioning, same install path.

```bash
axon publish
```

Run it from the cognet root. It bundles the source, registers the name, uploads the
version, and syncs visibility from `package.json`.

## What ships

**Source.** Not a compiled artifact.

That's a deliberate decision with a real consequence. A compiled cognet inlines the core
runtime it was built against — the bundle contains a copy of the kernel-side machinery it
talks to. Publishing that would pin every consumer to whatever core version your machine
happened to have at publish time.

Instead, the consumer compiles. `axon prepare` on their agent installs your source and
fuses it to the kernel it will actually run against. A cognet is always compiled for the
runtime it executes on.

Two more things follow from that:

**Your cognet is readable.** People clone it, read it, and fork it. For a layer this low,
that's the point — `@axon/zero` exists to be cloned.

**Core changes invalidate every bundle.** The compile step's cache key includes the core
source tree, so a kernel change rebuilds every agent's cognet automatically. No stale
fusion.

## Identity

Scoped names only:

```json
{
  "name": "@you/my-cognet",
  "version": "0.1.0"
}
```

The registry refuses the flat global namespace. The scope must be one you own — your
username, or an org you belong to.

Names are unique **across every kind**. If `@you/thing` is a module, it cannot also be a
cognet. One name, one artifact — which is why `axon clone @you/thing` needs no flag to
say what it's fetching.

## Versions are immutable

A published version can never be replaced. Bump before republishing — or let the CLI do
it: on a collision `axon publish` patches the version, rebuilds so the tarball and
registry metadata agree, and retries.

Consumers pin with ordinary semver:

```ts
export default defineAgent({
    cognet: "@you/my-cognet@^0.2.0",
})
```

Bun resolves and locks it like any other dependency. An unconstrained install leaves an
existing pin alone — only an explicit constraint moves it.

## Visibility

npm convention, and the only visibility contract:

```json
{ "private": true }
```

`true` keeps it private. Absent or `false` publishes publicly. Every `axon publish` syncs
this, so the file stays the source of truth.

There is no unpublish. `private: true` is the kill switch: existing installs keep
resolving, nothing new can find it.

## ABI compatibility

The one thing that makes cognet publishing different from module publishing.

Cognets version independently of the CLI, so an agent can pin `@you/my-cognet@0.1.0`
while its Axon moves forward. When the kernel ABI changes, an old cognet is genuinely
incompatible — not degraded, incompatible.

**You usually declare nothing.** A cognet publishes as *source* and is compiled by the
consumer against the kernel it will actually run on, so the compile step stamps in the ABI
it built against. The registry records that on the version row, which is how it answers
"newest version of this cognet that fits ABI 11" without downloading a tarball.

Pin `abi` only to make a cognet **refuse** a kernel it hasn't been validated against:

```ts
export default defineCognet({
    abi: "11",
    mode: { kind: "invocation" },
})
```

`axon prepare` then checks the pin against the kernel the installed Axon provides and
fails there, naming both versions:

```bash
COGNET_ABI_MISMATCH: cognet "@you/my-cognet" pins kernel ABI 9,
but this Axon provides ABI 11 — install a cognet version built for
ABI 11, or update Axon
```

At prepare time, with both numbers and the file to edit. Never at agent boot, from inside
a compiled bundle.

**When the ABI changes, publish a new major.** Consumers on the old ABI keep resolving the
old version; consumers on the new runtime pin the new one. Same discipline as any breaking
change, with the difference that the mismatch is mechanically detected rather than
discovered in production.

## Being selected

An agent picks its cognet in `axon.config.ts`:

```ts
export default defineAgent({
    cognet: "@you/my-cognet",
})
```

At `axon prepare` that becomes a package.json dependency, resolves through the registry,
installs into `node_modules`, gets ABI-checked, and compiles into the agent's
`.agent/cognet/`.

Exactly one per agent — an agent has one brain. Omitting the field selects `@axon/zero`.

### From local source

Before a cognet is published — or when the agent and the brain are developed together and
were never meant to be separate artifacts — import the cognet config directly, exactly as
you would a source module:

```ts
import Vehicle from "../../cognets/braitenberg-vehicle/cognet.config"

export default defineAgent({
    cognet: Vehicle,
})
```

The path comes from the import statement, resolved at prepare against the config's own
directory. No install step, no registry lookup, no version — the source is whatever you
have checked out, and edits to it hot-reload under `axon dev` like the agent's own files.

The ABI is resolved the same way either form ends at — a pin if the config carries one,
this kernel otherwise. Everything downstream is identical: the blueprint carries a compiled path and hash, and the runtime
cannot tell which origin produced it.

## Before you publish

A short list worth running through:

**Does `axon cognet prepare` pass?** It regenerates the frame and type-checks the source.

**Is `files` right in `package.json`?** Ship `cognet.config.ts` (if you have one), `src`,
and `plugins`. Leave out tests and scratch. `name` and `version` in this file ARE the
cognet's identity — nothing else declares them.

**Does it survive a cold start?** Kill the agent mid-wake and restart it. If your cognet
needs a graceful shutdown to be correct, the state that mattered was in RAM when it should
have been in the log.

**Do the phase names read well?** They're your trace. Someone debugging your cognet reads
those names before they read your code.

**Is the README worth reading?** It renders on the registry page. A cognet is a strategy,
and the useful thing to document is what strategy it implements and when someone would
want it.

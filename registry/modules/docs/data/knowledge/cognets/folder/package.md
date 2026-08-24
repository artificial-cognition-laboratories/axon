---
title: package.json
description: Registry identity, version, visibility, and npm dependencies.
---

# package.json

A cognet is a real package. This file carries the identity the registry uses and the
dependencies the compile step bundles.

```json
{
  "name": "@axon/zero",
  "version": "0.1.0",
  "description": "The default Axon cognet — the cognitive loop every agent runs unless it selects another.",
  "type": "module",
  "files": ["cognet.config.ts", "src", "plugins"]
}
```

## Identity lives here, not in the config

Two files carry a name and version, and they answer different questions.

| File | Owns |
|---|---|
| `package.json` | **registry** identity — the scoped name you publish and install |
| `cognet.config.ts` | **runtime** identity — the name the store namespaces by, the ABI |

`axon publish` reads `package.json`. The registry name must be scoped (`@you/my-cognet`);
publishing to the flat global namespace is refused.

```json
{ "name": "@cody/fast-loop", "version": "0.2.0" }
```

That's what an agent selects:

```ts
export default defineAgent({
    cognet: "@cody/fast-loop@^0.2.0",
})
```

## Visibility

npm convention, and it is the only visibility contract:

```json
{ "private": true }
```

`true` keeps it private. Absent or `false` publishes publicly. `axon publish` syncs this
to the registry on every publish, so the file is the source of truth rather than
something you set once in a UI.

## Versions are immutable

A published version can never be replaced. Bump before republishing — or let the CLI do
it: on a version collision `axon publish` patches the version, rebuilds so the tarball and
registry metadata agree, and retries.

Consumers pin with ordinary semver, resolved and locked by Bun like any other dependency.

## `files`

```json
{ "files": ["cognet.config.ts", "src", "plugins"] }
```

What ships in the published tarball. A cognet is published as **source** — the consumer
compiles it against the kernel it will actually run against — so this should carry
everything the compile step needs and nothing else.

Leave out tests, fixtures, and local scratch. Leave in anything `main.ts` or `plugins/`
imports.

## Dependencies

Ordinary npm dependencies, bundled into the artifact by the compile step:

```json
{
  "dependencies": {
    "gpt-tokenizer": "^2.5.0"
  }
}
```

Pure computation is the right shape here — tokenizers, math, parsers, data structures.
Packages that want I/O won't work: a cognet has no filesystem and no network, and a
dependency that opens a socket at import time will fail. Everything outward goes through
`kernel.run()`.

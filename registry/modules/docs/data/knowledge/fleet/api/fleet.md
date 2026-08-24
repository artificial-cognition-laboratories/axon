---
title: Fleet()
---

# Fleet()

Boots several agents in parallel and returns their handles under the names you gave
them. A global in every `*.axon.ts` script — `axon exec` binds it for the run, so
nothing is imported.

```ts
const { barry, checker, zeno } = await Fleet({
    barry:   "../barry",
    checker: "../checker",
    zeno:    "@axon/zeno",
})
```

## Signature

```ts
function Fleet<T extends Record<string, string>>(
    refs: T,
): Promise<{ [K in keyof T]: AxonHandle }>
```

**`refs`** — a map of local names to agent references. Each reference resolves the same
way as [`Axon()`](/docs/v2/fleet/api/axon): path, watch-path name, or registry package.

The keys are yours. They name the agent in this script and have no meaning to the agent
itself.

## What you get

Each value is an agent handle — the same thing `Axon()` returns as `runtime.axon`,
already unwrapped.

```ts
await barry.request("...")
barry.stream("...")
await barry.prompt("review", { file })
await barry.tools.fs.readFile(path)
barry.session.entries
```

Handles are fully independent. `barry.tools` is what `../barry` exports; `checker.tools`
is what `../checker` exports. No merged namespace, no shared memory, no crossover unless
you write it into a prompt.

## Resolution and boot

References all resolve before anything boots, so a bad reference fails before any
capsule exists. The set then boots in parallel — the call takes as long as the slowest
agent, not the sum.

A registry agent not yet on disk is fetched and installed during resolution. That run is
slower; later runs read the cache. Pre-install with
[`axon install`](/docs/v2/cli/install) to avoid paying it at runtime.

## Lifecycle

`axon run` shuts down every agent in the fleet when the script ends — returning,
throwing, or interrupted. Destructuring the result is safe; there is no fleet object you
need to hold.

Shutdown is error-isolated and always flushes session logs, so a crashed script still
leaves a complete trace per agent.

## Notes

**A convenience, not a layer.** `Fleet()` is `Promise.all` over `Axon()` with names
attached. It holds no state and manages nothing — the
[agent handle](/docs/v2/fleet/code) is the primitive, and anything above it is yours
to build.

**Two keys may point at one folder.** That boots the agent twice: two capsules, two
session logs, two independent conversations. Cheap and legitimate for request-response
agents; costly for continuous-mode ones, and it runs module setup twice.

**Fleets are local.** Every member boots on this machine from a folder on disk. Deployed
agents are reached over the network with a different surface — see
[Connecting](/docs/v2/deploy/connecting).

**Agents are optional.** A fleet script can do most of its work in plain TypeScript and
call `Fleet()` only when it reaches something needing judgment — including not at all,
if it exits early.

## See also

- [Agents in Code](/docs/v2/fleet/code) — the narrative version
- [Lifecycle](/docs/v2/fleet/lifecycle) — how references become folders, and teardown

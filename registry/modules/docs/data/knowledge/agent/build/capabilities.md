---
title: Adding Capabilities
---

# Adding Capabilities

You don't have to write everything your agent can do.

```bash
axon install @axon/discord        # your agent becomes a Discord bot
```

Run that from your agent directory. It's additive — nothing you wrote changes.

## Modules are installed. Prompts are not.

**A module** contributes tools, routes, and boot-time setup. After installing
`@axon/discord`, your agent has a Discord client wired into its lifecycle and
typed tools on `axon.tools`. You configure env keys and subscribe to its hooks;
you never touch its source.

A module is code: it links against the runtime, has an ABI, and belongs to the
agent that installed it. So it is a dependency, declared in your config:

```ts
export default defineAgent({
    modules: ["@axon/discord"],
})
```

Run `axon prepare` after installing, to regenerate type declarations. Your
editor then knows exactly what was added.

**A prompt package** contributes tasks — and it is not installed at all.

```bash
axon run @cody/eslint-scout:scout
```

That works without declaring anything. A prompt is content, not a capability:
the first time you run one it resolves into a machine-wide cache and renders on
the spot. Nothing is written to your agent, nothing is added to `node_modules`,
and no reload happens.

Which means every agent on your machine can already run every published prompt.
There is no `prompts: [...]` array, because a prompt was never a property of one
agent.

## Names never collide

A published prompt is namespaced by its package, so it cannot shadow one you
wrote:

```bash
src/prompts/scout.vue        →  axon run scout
@cody/eslint-scout:scout     →  axon run @cody/eslint-scout:scout
```

Different namespaces by construction, rather than a precedence rule you have to
keep in your head.

## Going further

Installing modules is covered in full — env keys, options, hooks, contributed
tools — in [`axon install`](/docs/v2/cli/install).

When you want to publish something yourself, a
[prompt](/docs/v2/agent/src/prompts) is two commands and no
build step. [Building a module](/docs/v2/modules/building) is the deeper track,
for when a task isn't enough and you need to add a real capability.

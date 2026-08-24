---
title: agents/
icon: vscode-icons:default-folder
---

# agents/

Your agents. Each is an ordinary agent project — the same folder an `axon init` produces
anywhere else.

```bash
agents/
└── zeno/
    ├── .agent/
    ├── src/
    ├── axon.config.ts
    └── package.json
```

This is where `axon clone` lands by default, and where `~` finds things to start.

## zeno

The default agent, guaranteed to exist. A first-run user has no agents and an agent is
the only thing that can run, so the platform ensures exactly one — **cloned from the
registry**, not written from a template.

That means improving the first thing a new user meets is a publish, not a CLI release.

It is an ordinary project after that: yours, editable, never written to again. Delete it
and it comes back on the next launch.

## Agents elsewhere

You are not limited to this folder. `settings.paths` in `profile.config.ts` adds more
scan roots:

```ts
export default defineProfile({
    settings: {
        paths: ["~/git/work/agents", "~/side-projects"],
    },
})
```

Anything under those appears in `~` beside the ones in here. Useful when your agents live
in a repo you already have checked out.

See [Agent Structure](/docs/v2/agent/folder) for what is inside one.

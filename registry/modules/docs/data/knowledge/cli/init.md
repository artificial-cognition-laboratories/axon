---
title: axon init
---

# axon init

Scaffold a new agent in the current directory.

```bash
axon init <name>
cd <name>
```

Creates `<name>/` with `axon.config.ts`, `src/` (including `boot.vue`), `server/`,
`data/`, `tests/`, and `modules/`. Installs dependencies and generates the `.agent/`
type frame automatically — there is no separate prepare step after `init`.

Other project kinds name themselves: `axon module init`, `axon cognet init`,
`axon bench init`, `axon prompt init`. Agents are the default, so they don't.

The scaffolded `axon.config.ts` contains placeholders for identity, engine, and policy.
Fill these in before running the agent.

See [Agent Structure](/docs/v2/agent/folder) for what each folder is for.

`axon init` always scaffolds into the current directory — it never picks a
location for you. If you want the new agent to show up in the terminal UI
(or in `axon` from another directory), watch its parent directory once with
[axon watch](/docs/v2/cli/watch).

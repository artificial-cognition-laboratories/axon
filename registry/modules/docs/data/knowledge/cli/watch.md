---
title: axon watch
---

# axon watch

Register a directory as a source of agents. Every immediate subdirectory
inside a watched path is treated as an agent project — both `axon` and the
terminal UI scan it the same way they scan your profile's own `agents/`
folder.

```bash
axon watch .
axon watch ~/projects
```

Requires an active login — watched directories are stored on your profile,
so the registry is the same wherever you sign in.

Watching a directory doesn't move or create anything. It just makes agents
that already live there (or get created there later) discoverable. This is
how a CLI-created agent — scaffolded with `axon init` in whatever directory
you happened to be in — shows up in the terminal UI: watch the parent
directory once, and everything under it is found from then on.

See [axon unwatch](/docs/v2/cli/unwatch) to remove a directory, and
[axon init](/docs/v2/cli/init) for scaffolding a new agent.

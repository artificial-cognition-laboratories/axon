---
title: axon install
---

# axon install

Install a registry module into the agent project at the current directory. The
command resolves the project from the working directory, so it is used directly
as `axon install` rather than through a project-type subcommand.

```bash
axon install <id>
axon uninstall <id>
```

`axon i` is a shorthand for `axon install` — same command, same arguments.

```bash
axon i @axon/arxiv
```

`<id>` is the registry identifier, always scoped: `@scope/name`. Every artifact in the
registry carries its scope as part of its identity, so a bare `name` resolves to nothing.

Installing exposes the module source as `node_modules/@scope/name`, merges its npm
dependencies into the agent's `package.json`, and materializes them locally. Installed
modules are discovered and plugged into the agent automatically; `modules/` remains for
local, relative-path modules.

If the module declares environment variable requirements, the CLI reports them.
Local development values belong in the project's `.env`; deployed values are
read from the agent project's `.env` on deploy.

```bash
axon install @acme/github
# → exposes source at node_modules/@acme/github/
# → merges dependencies
# → prints required environment keys
```

See [Modules](/docs/v2/modules/overview) for the module authoring reference.

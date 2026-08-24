---
title: axon module
---

# axon module

Create module projects. Publishing is a project command, so it is shared with
agents and benchmarks at the root of the CLI.

```bash
axon module init <name>     # scaffold a new module in the current directory
axon publish                 # from the module project directory
```

## axon module init

Creates `<name>/` with `module.config.ts` and empty `src/prompts/`,
`src/scripts/`, `src/tools/`, and `server/` directories. Run it from the
directory where the new module folder should be created.

```bash
axon module init my-module
cd my-module
```

## axon publish

Publishes the module source to the Axon registry. Run it from the module
directory; Axon detects the module project automatically.

Publishes source only. Excluded: `node_modules/`, `.env`, generated files. The user's
agent reconstructs dependencies from the merged `package.json` on `bun install`.

Versions are immutable — once published, a version cannot be overwritten. Bump the
version in `package.json` before each publish.

See [Publishing a Module](/docs/v2/modules/publishing) for the full publishing reference.

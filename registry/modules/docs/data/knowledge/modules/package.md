---
title: package.json
---

# package.json

Declares the module's npm dependencies and version. When the module is installed,
dependencies are merged into the parent agent environment and `bun install` runs
automatically.

```json
{
    "name": "@you/discord",
    "version": "0.1.0",
    "type": "module",
    "dependencies": {
        "discord.js": "^14.16.3"
    }
}
```

The agent author never manages these manually. They install your module and the
agent environment gets what it needs.

## What to declare

Any npm package your `src/` code imports. Do not declare Axon runtime globals —
`axon`, `defineArgs`, `defineModule` are injected at runtime, not from npm.

Keep dependencies minimal. Every package you add is installed into every agent that
uses the module.

## Dependency merging

When two installed modules declare the same package, versions are merged using the
highest compatible range:

```bash
# Module A: "discord.js": "^14.0.0"
# Module B: "discord.js": "^14.16.0"
# Agent gets: "discord.js": "^14.16.0"
```

Use `^` ranges rather than pinned versions. Pinned versions make conflict resolution
harder for agents with multiple modules installed.

## Versioning

`axon module deploy` auto-bumps the patch version on each deploy. Bump minor or
major manually in `package.json` before deploying when the change warrants it.
Published versions are immutable.

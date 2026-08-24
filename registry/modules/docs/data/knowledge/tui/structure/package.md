---
title: package.json
icon: vscode-icons:file-type-json
---

# package.json

A real manifest, because a profile is a real project.

```json
{
    "name": "axon-profile",
    "private": true,
    "type": "module",
    "dependencies": {
        "@arcforge/types": "2.0.141",
        "@types/bun": "^1.2.0"
    }
}
```

## Two dependencies, and no framework

A profile **configures a terminal**; it does not run an agent. So it installs types only —
not the agent runtime, not the kernel, not a cognet.

`@arcforge/types` is pinned to the exact version of Axon you are running, and re-pinned
when you update. That keeps the declarations in your editor identical to what your
terminal implements.

## Adding your own

```json
"dependencies": {
    "@arcforge/types": "2.0.141",
    "@types/bun": "^1.2.0",
    "zod": "^3.23.0"
}
```

Installed on the next launch, and importable from `main.ts` or any plugin. Useful when a
plugin needs a real library rather than what Bun already gives you.

## private: true

This is never published. `bun.lock` beside it is Bun's, and regenerable — neither needs
backing up.

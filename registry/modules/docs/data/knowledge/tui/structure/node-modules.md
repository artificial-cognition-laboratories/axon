---
title: node_modules/
icon: vscode-icons:folder-type-node
---

# node_modules/

Dependencies for your config. Installed by `bun`, regenerable, never committed.

```json
// package.json
{
    "dependencies": {
        "@arcforge/types": "2.0.141",
        "@types/bun": "^1.2.0"
    }
}
```

Two packages, and neither is the agent framework. A profile configures a terminal — it
does not run an agent — so it installs types only.

## What it is for

Your editor. `@types/bun` is what makes this typecheck in `main.ts` and any `plugins/`
file:

```ts
tui.hook("tui:shutdown", async () => {
    await Bun.write(`${process.env.HOME}/log.txt`, "done")
})
```

Bun's own globals are available in your config because this is a real project with a real
install — not because the TUI special-cases them.

## Regenerable

```bash
rm -rf node_modules    # next launch reinstalls
```

Add your own dependencies to `package.json` if a plugin needs one; the next launch
installs them.

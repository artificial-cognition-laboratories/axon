---
title: main.ts
icon: vscode-icons:file-type-typescript
---

# main.ts

Your config. It runs at module scope on every launch, and on every reload.

```ts
commands.register("deploy", {
    async run() {
        await commands.run("agent restart")
    },
    description: "Restart and redeploy",
})

keys.register("ctrl+o", () => commands.run("session open"))

palette.create("branches", {
    key: "&",
    async list() {
        return (await gitBranches()).map(name => ({
            id: name,
            label: name,
            action: () => checkout(name),
        }))
    },
})
```

There is no `setup()` and no default export. **Importing the file is loading it** —
`commands.register(...)` runs as the module body evaluates.

## Loads first, so it wins

```
main.ts  →  plugins/*.ts  →  each extension, in profile.config.ts order
```

Your own config beats every extension. A collision throws, naming both sides — nothing is
ever silently shadowed.

## Split it up

```ts
// main.ts
import "./keybindings"
import "./commands/git"
```

An ordinary import. Anything reachable from here runs, which is how a large config stays
navigable. (Do not import from `plugins/` — those already auto-load.)

## A throw does not cost you the terminal

```ts
commands.register("a", run)
throw new Error("boom")      // "a" stays registered
commands.register("b", run)  // never runs
```

Registrations made before the throw are kept, and the failure lands in the config error
list on the chat page. You still get a working terminal — the one you need in order to fix
it.

## Reloading

`:reload` re-runs everything, tearing down the previous generation first. Saving the file
does the same. Nothing accumulates across reloads.

See [API](/docs/v2/tui/api/tui) for the eight globals.

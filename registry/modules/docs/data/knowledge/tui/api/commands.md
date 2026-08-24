---
title: commands
---

# commands

Commands in the `:` tree. Built-ins always win a collision; between two extensions the
first loaded keeps the path and the second throws.

```ts
interface CommandsApi {
    // Add a command. Two forms — a bare function, or a definition object.
    register(
        path: string | readonly string[],
        run: (signal: AbortSignal) => void | Promise<void>
    ): Disposer
    register(
        path: string | readonly string[],
        definition: {
            run: (signal: AbortSignal) => void | Promise<void>
            description?: string      // shown beside the command in the palette
            workingMessage?: string   // shown in the working row while it runs
        }
    ): Disposer

    // Run one by path, exactly as pressing Enter on it would.
    // Throws COMMAND_NOT_FOUND on a missing path, or on a group.
    run(path: string | readonly string[]): Promise<void>

    // Every registered path, built-in and user. Dynamic groups are not expanded.
    list(): readonly string[][]
}
```

## Two forms

```ts
// Nothing to configure — just the behaviour.
commands.register("hello", () => tui.info("hi"))

// With presentation.
commands.register("sync", {
    async run(signal) {
        await longRunningThing({ signal })
    },
    description: "Sync everything",
    workingMessage: "syncing...",
})
```

Both reach the tree identically. Returning a promise holds the palette in a working row
until it settles; the `signal` aborts when the user presses `Escape` mid-flight.

## Nested paths

```ts
commands.register(["git", "push"], run)
commands.register(["git", "pull"], run)
```

Commands sharing a prefix share a group, created on demand — `:git ` now descends into
one with both. There is nothing to declare.

## Reaching what has no API

```ts
commands.register("fresh", async () => {
    await commands.run("agent clear")
    input.set("let's start over")
})
```

One verb, instead of re-exposing every command's implementation on the surface.

## Errors

```ts
commands.register("reload", run)                // COMMAND_PATH_TAKEN — built-in
commands.register("x", { description: "hi" })   // COMMAND_INVALID — no run
await commands.run("git")                       // COMMAND_NOT_FOUND — a group
```

`COMMAND_INVALID` fires at registration, not at press time — a command that registers
cleanly and does nothing on Enter reads as a broken terminal rather than a config mistake.

## Dynamic groups are not expanded

```ts
commands.list()
// [..., ["open"], ["module", "update"], ...]
//        ^ the group, not its rows
```

`:open` asks whether an editor is attached; `:module update` asks the registry what is
published. Expanding those in a read would boot composables as a side effect and return
rows true only for that instant. Reach one with `run()`.

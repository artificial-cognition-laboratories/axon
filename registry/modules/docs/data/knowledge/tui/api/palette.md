---
title: palette
---

# palette

The TUI's interaction primitive: your own lists, and asking the user a question. A palette
you register is the **same widget** as `:` — identical row shapes, filtering and
navigation — so every extension's UI is as good as the built-in one.

```ts
interface PaletteApi {
    // Your own palettes.
    create(name: string, definition: PaletteDefinition): PaletteHandle
    get(name: string): PaletteHandle | null
    open(name: string): Promise<void>   // throws if one is ALREADY open
    close(): void
    readonly isOpen: boolean            // real lists only — not loading/voice

    // Asking the user. All three resolve to a cancelled value on escape.
    pick(options: readonly string[], opts?: { placeholder?: string }): Promise<string | undefined>
    pick<T>(options: readonly PickOption<T>[], opts?: { placeholder?: string }): Promise<T | undefined>
    confirm(message: string): Promise<boolean>
    prompt(message: string, opts?: { placeholder?: string; initial?: string }): Promise<string | undefined>
}

type PaletteDefinition = {
    list: (query: string, tab: string | null) =>
        PaletteItem[] | PaletteResult | Promise<PaletteItem[] | PaletteResult>
    key?: string                // mode key that opens it from an empty input
    filter?: boolean            // true when you filter by query yourself
    tabs?: PaletteTab[]
    maxHeight?: number
    anchor?: "top" | "bottom"   // "bottom" = terminal-log feel
}

type PaletteItem = {
    id: string
    label: string
    description?: string
    action?: (signal: AbortSignal) => void | Promise<void>
    chunks?: readonly string[]      // independently searchable parts
    descendQuery?: string           // rewrite the query instead of running
    choices?: () => PaletteItem[]   // a follow-up list
    preview?: () => void            // run on cursor movement
    workingMessage?: string
    detach?: boolean                // close now, finish in the background
    header?: boolean
    separator?: boolean
}

type PaletteResult = {
    items: PaletteItem[]
    breadcrumb?: string | null
    status?: PaletteStatus
    invalid?: boolean   // the query cannot resolve to anything selectable
}

type PaletteHandle = {
    readonly name: string
    open: () => Promise<void>
    refresh: () => void   // drop the cached list; does not reopen
    dispose: Disposer
}

type PickOption<T> = { label: string; description?: string; value: T }
```

## A palette of your own

```ts
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

The TUI filters for you, so a list that ignores `query` is still searchable. Set
`filter: true` when you filter yourself.

## Searchable rows

```ts
{ id, label: "claude-sonnet-5", chunks: ["openrouter", "anthropic", "claude-sonnet-5"] }
```

Every query term narrows against any chunk — how ~400 models live in one flat list.

## Asking the user

```ts
commands.register("deploy", async () => {
    const env = await palette.pick(["staging", "production"])
    if (!env) return

    if (!await palette.confirm(`Deploy to ${env}?`)) return

    const tag = await palette.prompt("Tag", { initial: "latest" })
    if (!tag) return

    await runDeploy(env, tag)
})
```

Sequential awaits. There is no wizard framework because there does not need to be one —
each step resolves to a cancelled value on escape, so `if (!x) return` is the whole
control flow.

`pick` also takes objects when the choice is not a string:

```ts
const target = await palette.pick([
    { label: "main", description: "default", value: mainRef },
    { label: "dev", value: devRef },
])   // resolves to the ref, not the label
```

## isOpen

```ts
mode.set("command")    // isOpen === true
mode.set("loading")    // isOpen === false — a spinner, not a list
```

A palette is a list of rows to pick from. `loading`, `voice` and `escalation` are input
*states*, and nothing is being picked in any of them.

`open()` throws if another palette is already up — stealing it mid-navigation is the kind
of silent degradation that makes an extension system feel haunted. Check `isOpen` first
if a keybind might collide.

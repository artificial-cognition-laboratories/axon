---
title: mode
---

# mode

The active mode. Accepts any built-in and any palette registered with
`palette.create` — which is why `ModeName` is not a closed union.

```ts
interface ModeApi {
    // Switch modes. Throws MODE_UNKNOWN rather than silently doing nothing.
    set(mode: ModeName): Promise<void>

    // The active mode. "normal" when the user is just typing.
    get(): ModeName

    // The glyph currently shown at the input bar.
    symbol(): string
}

type ModeName = BuiltinMode | (string & {})
```

## Built-in modes

```ts
"normal"      // »   the message box
"command"     // :   the command tree
"agent"       // ~   start an agent
"instance"    // /   live conversations
"session"     // ^   past conversations
"model"       // *   set the agent's model
"module"      // %   agent modules
"prompt"      // >   insert a prompt
"theme"       // "   colour themes
"voice"       // #   voice input
"help"        // ?   keyboard reference
"file"        // @   file reference
"history"     // ↑   previous messages
"loading"     // ⠋   spinner — not user-activatable
"escalation"  // ‼   a capsule policy prompt
```

## Switching

```ts
await mode.set("command")    // as pressing : does
await mode.set("branches")   // a palette you created
await mode.set("normal")     // back to the message box
await mode.set("nope")       // MODE_UNKNOWN
```

Throws rather than silently doing nothing — a mode set that quietly failed would be
indistinguishable from one that worked and immediately closed.

`mode.set("normal")` and `palette.close()` are the same act. `palette.open()` is the
stricter door: it refuses to steal the palette from another.

## Reading

```ts
keys.register("ctrl+b", async () => {
    if (mode.get() !== "normal") return
    await palette.open("branches")
})
```

For "is a list open" specifically prefer `palette.isOpen` — it excludes `loading`,
`voice` and `escalation`.

## symbol() is not the mode key

```ts
mode.symbol()   // "»" in normal, ":" in command, "⠋" while loading
```

`loading` and `history` have glyphs but no key, and a palette registered without a `key`
still shows one. Asking is the only way to get what is actually painted.

## Reacting instead of polling

```ts
tui.hook("mode:changed", ({ from, to }) => {
    if (to === "voice") startVisualiser()
})
```

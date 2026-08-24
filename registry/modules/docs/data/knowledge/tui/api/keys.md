---
title: keys
---

# keys

Key chords. Bindings do not fire while a palette is open.

```ts
interface KeysApi {
    // Bind a chord. Throws KEY_CHORD_TAKEN if the terminal or another
    // extension owns it.
    register(chord: string, handler: () => void | Promise<void>): Disposer

    // Deliver a keypress as though the user had typed it.
    // Throws KEY_CHORD_UNBOUND if nothing answers to it.
    send(chord: string): void
}
```

## Binding

```ts
keys.register("ctrl+o", () => commands.run("session open"))

keys.register("ctrl+shift+r", async () => {
    await agents.reboot()
    tui.info("rebooted")
})
```

Chords are written the way they read — `"a"`, `"f5"`, `"ctrl+o"`, `"shift+tab"`,
`"ctrl+shift+p"` — and matched case-insensitively.

Nothing waits on a handler; it cannot block the keyboard. A rejection is caught and
reported as `ctrl+o failed` on the cwd row rather than taking the process down.

## Reserved chords

```
ctrl+c   ctrl+d   escape   enter   tab
up   down   left   right   backspace   delete
:  ~  /  ^  *  %  >  "  #  ?
```

```ts
keys.register("ctrl+c", run)   // KEY_CHORD_TAKEN
```

Refused at **registration**, not at press time: user bindings dispatch from a wildcard
handler that runs before exact-key ones, so a config that bound `ctrl+c` would beat the
exit ladder. By then it is too late to defer.

## Sending

```ts
keys.send("ctrl+o")   // a chord you bound
keys.send("&")        // a mode key your palette claimed
keys.send(":")        // a built-in mode key
```

The escape hatch that keeps the surface honest — anything the API forgot to expose is
still reachable, so a missing verb is an inconvenience rather than a wall.

## Guarding a mode key

```ts
keys.register("ctrl+b", async () => {
    if (palette.isOpen) return
    await palette.open("branches")
})
```

## Observing instead of claiming

```ts
tui.hook("key:pressed", ({ key, mode }) => {
    if (mode === "normal" && key === "ctrl+g") openThing()
})
```

Fires only for keys nothing handled, and cannot consume them. `key` round-trips —
`keys.register(key, fn)` accepts exactly what you receive.

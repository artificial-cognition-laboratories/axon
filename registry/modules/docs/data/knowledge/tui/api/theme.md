---
title: theme
---

# theme

Colours. Seven tokens, closed on purpose — every surface derives from these, which is what
makes a theme portable.

```ts
interface ThemeApi {
    // Register a theme. Throws if the name is taken.
    create(name: string, tokens: ThemeTokens): Disposer

    // Paint one and keep it (persisted). Throws on an unknown name.
    set(name: string): void

    // Every registered theme, built-ins first.
    list(): readonly Theme[]

    // The theme currently painted.
    readonly active: Theme
}

type ThemeTokens = {
    primary: ThemeColor      // accent: selection, input rule, focused rows, links
    background: ThemeColor   // the terminal's ground
    text: ThemeColor         // ordinary foreground
    dim: ThemeColor          // paths, descriptions, timestamps
    warn: ThemeColor         // needs attention, nothing failed
    error: ThemeColor        // something failed
    syntax: BundledSyntax | Record<string, unknown>
}

type Theme = ThemeTokens & { name: string }
type ThemeColor = ColorName | "transparent" | (string & {})
```

Before this existed the TUI had reached ~30 hard-coded colours — four greys nobody chose
deliberately, five reds. A theme API with a field per call site would have preserved that
forever.

## Registering

```ts
theme.create("midnight", {
    primary: "#7aa2f7",
    background: "transparent",
    text: "#c0caf5",
    dim: "#565f89",
    warn: "#e0af68",
    error: "#f7768e",
    syntax: "tokyo-night",
})

theme.set("midnight")   // create does not paint
```

Colours take a name, hex, `rgb()`/`rgba()`, or `transparent` — which means "paint nothing
and let the real terminal show through", usually right for `background`.

`syntax` takes a bundled theme name or a TextMate object. Unlike colours that union is
**closed**: an unrecognised colour still renders, but an unrecognised syntax name loads
nothing, so it is always a typo.

## Deriving from an existing theme

```ts
const base = theme.list().find(t => t.name === "gruvbox")
if (base) theme.create("gruvbox-dim", { ...base, dim: "#665c54" })
```

`list()` entries carry their full token set, not just the name — as does `theme.active`.

## Live preview

```ts
palette.create("themes", {
    key: "T",
    list: () => theme.list().map(t => ({
        id: t.name,
        label: t.name,
        preview: () => theme.set(t.name),   // paints as the cursor moves
        action: () => theme.set(t.name),
    })),
})
```

That is what `"` does.

## Shipping one

A theme is an ordinary extension — `theme.create` in its `main.ts`, published to the
registry, installed with `axon install`. It loads from
[`profile.config.ts`](/docs/v2/tui/structure/config) like any other.

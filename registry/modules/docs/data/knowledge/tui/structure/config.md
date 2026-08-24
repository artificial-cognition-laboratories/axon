---
title: profile.config.ts
icon: vscode-icons:file-type-typescript
---

# profile.config.ts

Which extensions to load, and your settings.

```ts
export default defineProfile({
    extensions: [
        "@axon/gruvbox-theme@1.0.3",
        "./extensions/mine",
    ],

    settings: {
        theme: "gruvbox",
        paths: ["~/git/work/agents"],
    },
})
```

Read **without running any extension** — which is what lets `axon ext install` edit this
list safely.

## extensions

Load order, top to bottom, after `main.ts`. First registration wins a collision.

```ts
extensions: [
    "@axon/vim@0.2.0",      // registry — fetched and pinned
    "./extensions/mine",    // local path — loaded where it sits
]
```

A registry entry is **pinned**. The version you see is the version that loads; an
unpinned name would mean your terminal silently changing under you.

Managed with `:ext install`, `:ext update` and `:ext uninstall` — all of which rewrite
this array rather than asking you to.

The files themselves are not in your profile. A registry extension lives in
`~/.axon/cache/extensions/`, shared machine-wide, which is why uninstalling undeclares
rather than deletes.

## settings

```ts
settings: {
    theme: "gruvbox",                    // built-in, or one an extension registers
    paths: ["~/git/work/agents"],        // extra roots to scan for agents
}
```

`theme` is the same value `"` writes when you pick one, so switching in the TUI edits this
file. `paths` adds scan roots beyond `agents/` — see
[agents/](/docs/v2/tui/structure/agents).

## Edited by hand or by command

Both work, and both take effect on save: the TUI watches this file, and a `:ext install`
writes it the same way you would.

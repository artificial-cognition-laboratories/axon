---
title: plugins/
icon: vscode-icons:folder-type-plugin
---

# plugins/

Lifecycle code. Every `.ts` file in here loads on launch — no import, no export, no
wrapper.

```ts
// plugins/worklog.ts
const sent: string[] = []

tui.hook("message:sent", ({ content, instance }) => {
    sent.push(`${instance.name}: ${content}`)
})

tui.hook("tui:shutdown", async () => {
    if (sent.length) await Bun.write(`${process.env.HOME}/worklog.md`, sent.join("\n"))
})
```

Files load alphabetically, after `main.ts`. Each is independent: one that throws disables
itself and nothing else.

## A convention, not a capability

`tui.hook()` works from `main.ts` too, and a plugin can register commands and keys. The
folder exists so lifecycle code has somewhere obvious to live, and so it loads without
you importing it.

Just don't do both:

```ts
// main.ts
import "./plugins/worklog"   // ✗ auto-loaded AND imported — registers twice
```

## One file per concern

```bash
plugins/
├── worklog.ts      # message:sent → disk
├── resume.ts       # tui:shutdown / tui:boot → last agent
└── notify.ts       # message:received → desktop notification
```

Nothing enforces this, but a throw contains itself to one file — so splitting means a
broken plugin costs you one behaviour instead of all of them.

See [`tui.hook()`](/docs/v2/tui/api/tui#hooks) for every event and what each carries.

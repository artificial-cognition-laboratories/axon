---
title: .axon/
icon: vscode-icons:default-folder
---

# .axon/

Generated types. Created on boot, regenerated whenever the framework version changes.
Never edit anything inside it.

```bash
.axon/
└── types/
    ├── globals.d.ts    # the eight globals, as ambient declarations
    └── tsconfig.json   # the config your tsconfig.json extends
```

## Why your config has autocomplete

```ts
// main.ts — no imports, full types
commands.register("deploy", async () => {
    await agents.reboot()
})
```

`globals.d.ts` is the TUI extension contract wrapped in `declare global`. It is copied
verbatim from the version of Axon you are running, so the types in your editor are always
the ones your terminal actually implements.

## tsconfig.json

The profile root has a one-line `tsconfig.json`:

```json
{ "extends": "./.axon/types/tsconfig.json" }
```

Two files rather than one because the generated half is regenerated and the root half is
yours — you can add options to it without them being wiped on the next framework update.

## Regenerable

```bash
rm -rf .axon    # next launch rebuilds it
```

Nothing in here is authored, so nothing is lost. If your editor stops resolving the
globals, this is the folder to delete.

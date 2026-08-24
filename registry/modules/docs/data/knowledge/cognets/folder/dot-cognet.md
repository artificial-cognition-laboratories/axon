---
title: .cognet
description: Generated type declarations — commit them, don't edit them.
---

# .cognet

```bash
.cognet/
├── globals.d.ts     # ambient globals, typed for the editor
└── tsconfig.json    # the canonical config for cognet source
```

Both files are generated. `axon prepare` writes them, and the first line of each says so.

```bash
axon cognet prepare
```

Run it after scaffolding, after upgrading Axon, or any time your editor stops recognising
`loop` and `kernel`.

## Why globals need declaring

The ambient globals are installed at runtime by the compile host — importing that module
is what puts `loop`, `kernel`, `phase`, and `system` on `globalThis`. That works, but your
editor has no way to know it happened.

`globals.d.ts` is the declaration that closes the gap:

```ts
declare global {
    /** THE entry point — declare the tick pipeline once, in src/main.ts. */
    function loop(body: (ctx: {
        stimuli: readonly AxonStimulusEntry[]
        signal: AbortSignal
        stop(): void
    }) => Promise<void>): void

    /** the syscall table — live from load() onward */
    const kernel: KernelAbi

    /** a named stage within a tick — cognet:phase:* telemetry */
    function phase<T>(name: string, fn: () => Promise<T>): Promise<T>

    /** a unit of work within a phase — timed for the flame graph */
    function system<T>(name: string, fn: () => Promise<T>): Promise<T>
}
```

The types come from `@arcforge/types`, so `kernel.store.get("checkpoint")` is typed
against your own `CognetStoreSchema` declaration and a syscall you got wrong is a red
squiggle rather than a runtime failure.

## Commit it

Unlike `node_modules`, this belongs in version control. It's small, it's deterministic,
and committing it means a fresh clone type-checks before anyone runs a build.

Don't edit it. `axon prepare` overwrites the file wholesale, and any change you make will
disappear the next time anyone runs it. If a global is wrong, the fix is in the generator,
not here.

## The scaffold and prepare agree

`axon cognet init` writes this frame using the *same* generators `axon prepare` runs. That
isn't a detail — it's why a freshly scaffolded cognet and a repaired old one end up
identical. There is no second template to drift.

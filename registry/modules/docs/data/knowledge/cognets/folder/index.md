---
title: Cognet Folder
description: The files that make up a cognet, and what each one owns.
---

# Cognet Folder

A cognet is a folder. Everything Axon needs to compile, type-check, and load a brain
lives here.

```bash
my-cognet/
├── .cognet/           # generated globals.d.ts + tsconfig — commit, don't edit
├── plugins/           # lifecycle hooks: boot, wake, tick, shutdown
├── src/
│   ├── main.ts        # the brain — declares loop()
│   └── state.ts       # resident memory, shaped however you like
├── cognet.config.ts   # identity and ABI version
└── package.json       # name, version, npm deps
```

Two files are required: `cognet.config.ts` and `src/main.ts`. Everything else is
optional.

## The split

Identity and behaviour never live in the same file.

**`cognet.config.ts`** declares what this cognet *is* — name, version, the kernel ABI it
targets, how it wants to be woken. Pure data, no logic.

**`src/main.ts`** is what it *does*. A raw script that runs once at load and declares
exactly one `loop()`.

The compile step composes the two into the artifact the kernel loads. That's why neither
file contains lifecycle boilerplate: the desugaring happens in the build, and there is no
side channel around it.

## What the compile step does

`axon prepare` on an agent that selects your cognet:

```bash
axon prepare
```

1. **Installs** the cognet from the registry, like any other dependency.
2. **Checks the ABI** it declares against the kernel this Axon provides. A mismatch fails
   here, naming both versions — never at agent boot.
3. **Wraps `main.ts`** — hoists its imports out, defers its body into a callable.
4. **Generates an entry** that imports the host first (so the ambient globals exist before
   your code evaluates), then composes host + config + main.
5. **Bundles** the result into one self-contained ESM file with a manifest.

The output lands in the agent's `.agent/cognet/`, not in your cognet folder. Your source
tree stays exactly as you wrote it.

Compilation happens on the machine that runs the agent, against the core runtime that
machine has. That's deliberate: a cognet is published as source, so it fuses to the
kernel it will actually run against rather than one frozen at publish time. See
[Publishing](/docs/v2/cognets/building/publishing).

## Scaffolding one

```bash
axon cognet init my-cognet
```

Writes the folder, generates the `.cognet` frame, and leaves you with a `main.ts` that
declares an empty loop with the three phases stubbed out.

To start from a working brain instead, clone the reference cognet:

```bash
axon clone @axon/zero
```

That gives you `zero` — the default cognet every agent runs unless it selects another —
as an editable project. See [Anatomy of zero](/docs/v2/cognets/building/zero).

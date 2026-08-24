---
title: src
description: The brain's source tree — one required file, the rest is yours.
---

# src

```bash
src/
├── main.ts      # required — declares loop()
└── state.ts     # convention — resident memory
```

`main.ts` is the only file the compile step looks for. Everything else is ordinary
TypeScript that `main.ts` imports, bundled into the artifact along with it.

## What gets bundled

The compile step follows the import graph from `main.ts` (and from `plugins/`) and inlines
everything into one self-contained ESM file. So splitting the brain across files costs
nothing at runtime:

```bash
src/
├── strategy/
│   ├── critique.ts
│   └── plan.ts
├── main.ts
├── parse.ts         # interpreting engine output
├── render.ts        # context assembly
└── state.ts
```

Normal imports, normal module scope, one copy of each module per brain.

## A note on dependencies

npm packages work — declare them in `package.json` and import them normally. They're
bundled in with your source.

What does *not* work is reaching for the environment. There is no `node:fs`, no
`node:net`, no `process.env` that means anything. A cognet that imports a package which
opens a socket at import time will fail, and it should: the
[kernel contract](/docs/v2/cognets/engine/kernel-contract) is the only door to the
outside, and it is a narrow one.

Pure computation is fine. A tokenizer, a math library, a parser, a data structure — all
ordinary dependencies. Anything that wants I/O belongs on the other side of
`kernel.run()`.

## Suggested shape

For anything beyond a trivial loop, the split that tends to hold:

| File | Owns |
|---|---|
| `main.ts` | the pipeline — which phases run, in what order, under what conditions |
| `state.ts` | the resident model |
| `render.ts` | turning the model into whatever the engine consumes |
| `parse.ts` | turning engine output back into decisions |

That keeps `main.ts` readable as a description of how the brain thinks, which is the file
someone reads first when they clone your cognet.

`zero` uses `main.ts` + `state.ts` and puts its grammar in a shared library, because its
render step is a call into the AIR format rather than bespoke logic. See
[Anatomy of zero](/docs/v2/cognets/building/zero).

---
title: Bench Folder
description: The files that make up a benchmark, and what each one owns.
---

# Bench Folder

A benchmark is a folder. Four directories, one config, and every one of them means exactly
one thing.

```bash
my-bench/
├── .bench/             # generated types, run logs, materialized workspaces
├── fixtures/           # author-side inputs — never visible to the agent
├── tests/              # the scenarios
│   └── fix-bug.bench.ts
├── workspace/          # the agent's world — copied fresh for every run
├── bench.config.ts     # what varies, and what is measured
├── package.json        # name, version, npm deps
└── README.md           # methodology and limitations
```

Two things are required: `bench.config.ts` and at least one file in `tests/`. A benchmark
with no workspace runs against an empty world, which is fine for anything that does not
need one.

## The split that matters

**`workspace/` is what the agent sees. `fixtures/` is what you see.**

That is a guarantee, not a convention. The workspace is copied into a fresh directory for
every single run, and the agent is booted with that copy as its root. Rubrics, expected
outputs, judge prompts, and setup data live in `fixtures/`, where the subject cannot reach
them.

If fixtures were visible to the agent, two things would break. A model could read the
answer key. And a run would come to depend on the benchmark's own directory layout, which
means it would stop being reproducible the moment someone reorganised the repo.

## Where each concern lives

**`bench.config.ts`** declares what *varies* and what is *measured*. The matrix, the trial
count, the measurement schema, the workspace policy. Data and one optional `setup()` hook
— no scenario logic.

**`tests/`** is what the agent has to *do*. Ordinary Bun test files, one scenario each.
This is where `Axon()` is booted and where observations are recorded, and it is the file
you spend your time in.

The split is the same one agents and cognets use: identity and behaviour never share a
file. The config gives observations stable meaning; the tests produce them.

## Naming

Test files match `tests/**/*.bench.ts` by default. The `.bench.ts` suffix keeps them
distinct from the workspace's own test suite — which matters, because a coding benchmark's
workspace usually contains real tests the agent is supposed to make pass, and those are
data rather than scenarios.

Override the pattern when a benchmark wants a different layout:

```ts
export default defineBench<Schema>({
    tests: ["scenarios/**/*.ts"],
})
```

## What is generated

`.bench/` is written by `axon bench prepare` and holds the generated declarations, the
extracted measurement schema, run logs, and any retained workspaces.

Commit the declarations; ignore the runs. A fresh scaffold does this for you:

```bash
.bench/runs/
.bench/workspace/
```

## Scaffolding one

```bash
axon bench init my-bench
```

Creates the whole structure, ready to prepare. See
[Your First Benchmark](/docs/v2/bench/building/first) for what to put in it.

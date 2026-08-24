---
title: Publishing
description: Ship the experiment, not the score.
---

# Publishing

A benchmark is a registry artifact like an agent, a module, or a cognet.

```bash
axon publish
```

```bash
✓ Published @you/parser-bench@0.1.0 (public)
  run it with `axon clone @you/parser-bench`
```

What ships is the **definition** — config, tests, workspace. Not the results.

## Why results are not part of the artifact

A run's observations belong to whoever spent the tokens producing them. Publishing a
benchmark says *here is an experiment you can run*; publishing a score says *here is what I
measured*. They are different claims, and bundling them would make the second one
unavoidable.

It also keeps the artifact honest. A benchmark whose published form included its author's
numbers would quietly become a leaderboard where the author always ran first, on their
hardware, with their models.

## What gets included

```bash
my-bench/
├── .bench/runs/        ✗ your run history stays local
├── fixtures/           ✓ rubrics and expected outputs
├── tests/              ✓ the scenarios
├── workspace/          ✓ the world, so the task is reproducible
├── bench.config.ts     ✓ matrix, schema, setup
└── package.json        ✓ identity and engine dependencies
```

`workspace/` ships because the world *is* the task. A benchmark that told you to supply
your own repository would not be the same benchmark twice.

## Running someone else's

```bash
axon clone @you/parser-bench
cd parser-bench
axon bench prepare
axon bench run
```

Their scenarios, their workspace, their measurement schema — against whatever matrix you
declare. Swap the models for the ones you care about, point the `agent` axis at your own
project, and the numbers you get are comparable with theirs because everything except what
you deliberately varied is identical.

## Comparability

Results carry a manifest, and the manifest carries hashes: the benchmark's content, the
measurement schema, the workspace, the harness version, and a pin for every axis — including
the ones held constant.

That is what decides whether two results can be compared at all. Same benchmark, same
schema, same workspace, compatible harness: comparable. Anything else and the results
describe different experiments that happen to share a name.

Which is why bumping the version matters when what you *measure* changes, not only when the
code does:

```bash
npm version minor
axon publish
```

A benchmark that redefined `resolved` without a version bump would let old and new numbers
land in the same aggregate. That is worse than having no aggregate — a wrong comparison is
harder to notice than a missing one.

## Visibility

```bash
axon publish            # private — you and your org
axon publish --public   # listed in the registry
```

Private is the default. A benchmark measuring something specific to your product is often
exactly the benchmark you want, and exactly the one nobody else needs.

## Writing a README

The registry shows it, and for a benchmark it carries weight the code cannot:

- **What this measures**, in one sentence
- **Why the task is representative** — why this bug, this repo, this prompt
- **Known limitations** — what it does not tell you
- **Suggested trials** — how many runs before the numbers mean anything

The last one is worth stating explicitly. Someone cloning a benchmark will run it with
whatever `trials` you shipped, and a default of 1 published without comment quietly invites
a single-sample result to be treated as a finding.

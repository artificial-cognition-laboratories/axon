---
title: workspace/
description: The agent's world — copied fresh for every run, and the only thing it can see.
---

# workspace/

`workspace/` is the world the agent works in. A repository with a bug in it, a directory of
documents, a project scaffold — whatever the task is about.

```bash
my-bench/
└── workspace/
    ├── src/
    │   └── parser.ts
    ├── tests/
    │   └── parser.test.ts
    └── package.json
```

It is copied into a fresh directory for every run, and the agent boots with that copy as
its root. The directory here is never mutated: it is the source of truth, and every trial
gets an identical clone of it.

That is what makes trials comparable. Six runs of the same test against the same workspace
start from byte-identical worlds, so any difference in outcome came from the variation
under test rather than from residue left by the run before.

## Declaring it

```ts
export default defineBench<Schema>({
    workspace: { source: "./workspace", retain: "failed" },
})
```

`source` defaults to `./workspace`, so a benchmark that uses the conventional layout can
omit it entirely. A benchmark that needs no world at all declares none, and the agent gets
an empty directory.

## Retention

Runs are cheap to lose and expensive to reproduce. `retain` decides which worlds survive:

| | |
|---|---|
| `never` | discard every workspace |
| `failed` | keep the world of any trial that did not complete |
| `always` | keep all of them |

`failed` is the default and usually the right one. When a trial fails, the world it failed
in tells you more than any number about it — the half-applied patch, the file it should not
have touched, the dependency it installed. It sits under `.bench/` exactly as the agent
left it.

## Captured changes

Whatever the retention policy, what changed is recorded on the trial:

```ts
observe("collateral", (await workspace.changed()).length - 1)
```

The harness snapshots the world before the agent boots and diffs it afterward, which is why
`changed()` can answer a question the test itself never had the information to answer.

Capture is tunable when the defaults get in the way:

```ts
workspace: {
    source: "./workspace",
    capture: {
        ignore: [".git", "node_modules", ".axon"],
        maxBytes: 10 * 1024 * 1024,
    },
}
```

The ignore list exists because `node_modules` appearing in a diff is noise, not signal, and
a benchmark whose install step dominates its change record is measuring the wrong thing.

## What cannot be in here

Symlinks are refused before a run starts, not followed. A symlink in a workspace is a path
out of the world — the whole point of the copy is that the agent's reachable filesystem is
bounded and identical every time, and a link pointing at the benchmark's own directory
breaks both properties at once.

The same reasoning covers `fixtures/`. Anything the agent must not see — expected outputs,
judge rubrics, grading data — belongs there instead, one level up and out of reach.

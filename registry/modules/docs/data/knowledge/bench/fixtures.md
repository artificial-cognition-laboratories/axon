---
title: fixtures/
description: Author-side inputs — setup data, rubrics, expected outputs. The agent never sees them.
---

# fixtures/

`fixtures/` is for everything the *benchmark* needs and the *agent* must not have.

```bash
my-bench/
└── fixtures/
    ├── expected/
    │   └── parser.ts       # the reference solution
    ├── subject/            # the agent under test
    │   └── axon.config.ts
    ├── rubric.md           # grading criteria for a judge
    └── seed.sql            # data for setup()
```

Expected outputs, grading rubrics, judge prompts, seed data, comparison baselines — and the
agents themselves. Read by `setup()` and by your tests; never copied into the world the
agent runs in.

An agent under test is a fixture, not part of the world. The `agent` axis points at it:

```ts
matrix: {
    agent: "./fixtures/subject",
}
```

A single value is a held constant — no array needed. And a trusted base from the
registry needs no fixture at all:

```ts
matrix: {
    agent: "@axon/coding-base",
}
```

Registry agents are fetched into `.bench/agents/` rather than here: `fixtures/` is
source you author and commit, `.bench/` is generated and ignored. Vendoring a copy of
a shared base into your own source would put it back under your control, which is
exactly what naming a registry version avoids.

## Why it is a separate directory

Two reasons, and both are about keeping results honest.

**The agent could read the answer.** A reference solution sitting in the workspace is
findable by anything with a filesystem tool. A benchmark that leaks its own answer key is
measuring retrieval, not capability — and it would do so silently, producing high scores
that look like good news.

**Reproducibility.** The workspace is copied and the copy is the agent's root, so its
reachable filesystem is bounded and identical every run. Fixtures are read from the
benchmark directory by the harness, which means they cannot become part of what the subject
depends on. Move the benchmark, restructure the repo, clone it onto another machine — the
agent's world is unchanged.

## Using them

From `setup()`, which runs after the workspace copy and before the agent boots:

```ts
export default defineBench<Schema>({
    async setup() {
        await seedDatabase(await Bun.file("./fixtures/seed.sql").text())
    },
})
```

From a test, for grading:

```ts
it("matches the reference implementation", async ({ workspace }) => {
    const { axon } = await Axon()
    await axon.request("Implement parseLine in src/parser.ts")

    const expected = await Bun.file("./fixtures/expected/parser.ts").text()
    const actual = await workspace.read("src/parser.ts")

    observe("exact_match", actual.trim() === expected.trim())
})
```

The test can read both sides. The agent can only read one.

## Judges

When a benchmark grades with a model rather than an assertion, the rubric belongs here:

```ts
const rubric = await Bun.file("./fixtures/rubric.md").text()
```

Two things matter about judges beyond where the rubric lives. The judge must be held
**constant** across the matrix — if the assessor varies alongside the subject, the measuring
instrument is changing with the thing being measured, and the numbers compare nothing. And
its token spend is recorded separately from the subject's, so the cost of grading never
contaminates the cost of the work.

## What does not belong here

Anything the task genuinely requires. If the agent needs a config file, a dataset, or a
dependency to do its job, that is part of its world and belongs in
[`workspace/`](/docs/v2/bench/workspace).

The test is simple: would a person doing this task by hand need it? If yes, it is the
workspace. If it only exists to check their work, it is a fixture.

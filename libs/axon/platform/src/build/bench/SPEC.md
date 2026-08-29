# Bench API — the locked shape

Status: design agreed, not yet implemented. This is the target; `CLAUDE.md`
describes what exists today.

## The whole surface

```ts
type Schema = {
    /** Has the agent resolved the bug? */
    resolved: boolean

    /** Files edited beyond the target. @objective minimize */
    collateral: number

    /** Strategy the agent took. */
    approach: "refactor" | "patch" | "rewrite"
}

export default defineBench<Schema>({
    description: "Can the agent fix a real bug without collateral damage?",

    workspace: { source: "./workspace", retain: "failed" },

    matrix: {
        model: [
            Mock({ fix: run("...correct patch...") }),
            Mock({ fix: "I can't do that" }),
        ],
    },

    trials: 3,

    async setup() {
        // after the workspace copy, before the subject boots
    },
})
```

```ts
// tests/fix-bug.bench.ts
it("resolves the failing test", async ({ workspace }) => {
    expect(workspace).toHaveFile("src/parser.ts")

    const { axon } = await Axon()
    await axon.request("Fix the failing test in src/parser.ts")

    observe("resolved", await workspace.tests.pass())
    observe("collateral", (await workspace.changed()).length - 1)
})
```

Four concepts: **what varies** (matrix), **the world** (workspace), **the
scenario** (tests), **what is measured** (Schema). Nothing else is required.

## Why each piece is shaped this way

### `expect` vs `observe`

A test encodes what you already know should happen. A benchmark exists
because you do not.

- **`expect`** — did the SCENARIO hold? A failure means this trial measures
  nothing; it is excluded, not scored zero.
- **`observe`** — how did the SUBJECT do? Recorded whatever the value is.

They cannot merge. `expect` throws on first failure, so a benchmark whose
weak conditions all failed would report itself broken — and every measurement
after the first failure would be lost, precisely on the runs that need them.

### `matrix`

Every key is a binding point in the assembled blueprint; every value list is
an axis. One key is the controlled experiment. Several multiply, and the
growth is the author's to manage rather than the runtime's to hide.

Named axes (`agent`, `cognet`, `model`, `env`) cover the common cases; dotted
paths (`config.engine.temperature`) reach anything else. The named set stays
small BECAUSE the paths exist — an earlier design had eight "factor kinds" of
which three were ever wired.

Variation ids are derived from values, not positions: `model[0]` would mean
something different after a reorder, and cell ids built from it would stop
matching earlier runs of the same benchmark. Collisions (`Mock()` twice)
suffix rather than reject — two mocks with different reply maps are a
meaningful pair the id cannot otherwise distinguish.

### `Schema` as a TypeScript type

The type is the authoring surface; JSON is not. A doc comment is where a
description naturally lives, and a union type is how anyone would write a
category.

But a `type` is erased at compile time, and the manifest needs the schema as a
VALUE:

- `BenchCohortKey` hashes it to decide whether two people's results are
  comparable
- `BenchCoverage` reports "expected 4, observed 3" — undetectable if you only
  know about measurements that fired

So `prepare` extracts the type into `.bench/schema.json` via
`ts.createProgram()`, and the runtime reads that. The author writes a type;
the system keeps a value. This is the same machinery `declareTools()` already
uses (worker-isolated, content-hash cached — see `scan/tools.ts`).

Derived from the type:

| from | to |
|---|---|
| property name | measurement id |
| property type | `value.kind` (`boolean`, `number`, union → `category`) |
| JSDoc text | `description` |
| `@objective minimize` | direction, where it is not obvious |
| `@unit ms` | display suffix |

`aggregate` defaults by kind — boolean → `rate`, number → `mean`, category →
`count`. `weighting` / `grain` / `missing` remain available and out of sight.

**`description` is required to publish, optional to run.** A shared benchmark
whose measurements have no stated meaning cannot be interpreted by whoever
reads the leaderboard; a bench you are iterating on locally should not nag.

### Visualisation is derived, never declared

No `chart`, `display`, or `format` field. The moment one exists you need
`scatter`, `heatmap`, `stacked`, `logScale`, `colorBy` — and every bench
author becomes a dashboard designer. That is exactly how `measurements`
reached ten fields the first time.

Chart type follows from data shape, not author intent:

| data | chart |
|---|---|
| boolean × cells | bar of rates |
| number × cells | box plot (trials give the distribution) |
| category × cells | stacked bar |
| number × number | scatter |
| number, step grain | line |
| two matrix axes | grid / heatmap |

`objective` supplies the only intent a chart needs: which direction is good.

Presentation is a projection over the semantic schema, exactly as aggregates
are a projection over observations. Add a presentation field only when a real
chart demonstrably cannot be derived — earned by a chart that exists, not
anticipated.

## Directory contract

```
bench.config.ts   matrix, measurements schema, setup
workspace/        the agent's world — copied fresh per iteration
fixtures/         author-side inputs; NEVER visible to the agent
tests/            scenarios, and where measurements are recorded
.bench/           generated declarations, extracted schema, run logs
```

The `workspace/` ↔ `fixtures/` split is an invariant. If fixtures leaked into
the agent's view, a run would depend on the bench's own layout and stop being
reproducible.

## Testing without live APIs

`Mock()` varies behaviour, not just labels — pattern maps, ordered sequences,
and `run()` steps that execute in the capsule:

```ts
matrix: {
    model: [
        Mock({ fix: run("...correct patch...") }),          // succeeds
        Mock({ fix: "I can't do that" }),                    // fails
        Mock({ fix: [run("...wrong..."), run("...right...")] }), // succeeds on retry
    ],
}
```

That exercises matrix expansion, subject binding, measurement collection and
replay end to end, with a real pass/fail spread and no API cost.

## Build order

1. **Object-keyed measurements** — `{ resolved: { description } }`. Small
   change to working code, cuts nine fields to one or two, and carries
   identical information to a `Schema` type so the migration is mechanical.
2. **Workspace assertions** — `workspace.tests.pass()`, `.changed()`,
   `toHaveFile()`. The blocker for any real bench;
   `benchmark0/tests/fix-bug.bench.ts` is written against this and marked
   not-yet-runnable.
3. **`toolCalls`** — hardcoded to `0` in `preload.ts`, and one of the most
   diagnostic numbers for a coding benchmark.
4. **Schema extraction** — after two or three real benches exist, so the
   extractor is designed against real schemas rather than imagined ones.
5. **Aggregation** — `aggregate.ts` is types with no consumers. Build against
   a real result set; designing it in the abstract is how it got ahead of the
   code.

## Still open

**Cases.** `BenchTrialRecord.case` exists and nothing fills it. A dataset
(SWE-bench's 2,294 instances) is the population you measure OVER, not an axis
— it must not enter the Cartesian product. Nothing expresses that yet, and it
is the one design question the current shape does not answer.

**Multi-agent.** `BenchPhysics` already separates `subject` from `assessor`,
so the types anticipate a judge; the runtime boots one agent. An LLM judge
must be held CONSTANT across the matrix, or the measuring instrument varies
with the thing measured. Blocked on whether `Axon()` becomes a manager of
several instances — a runtime question, not a bench one.

---
title: Measuring
description: expect versus observe, and declaring what a benchmark records as a TypeScript type.
---

# Measuring

A test suite says: *these assertions must hold, or I am unhappy.* It encodes something you
already know should be true, and stopping at the first violation is the correct response.

A benchmark cannot say that. It exists because you do not know what will happen — that is
the entire reason to run it. Halting on the first surprise throws away the data you built
the experiment to collect.

So there are two verbs.

## expect is for the harness

`expect` asks whether the *scenario* held. The workspace copied, the agent booted, the
file the task refers to is actually there.

```ts
expect(workspace).toHaveFile("src/parser.ts")
```

If that fails, this run measured nothing. The world was not what the scenario assumed, so
the trial is **excluded** — not scored zero. A zero would be a claim about the agent; an
exclusion is the truth, which is that nothing was tested.

## observe is for the subject

`observe` records how the *subject* did. It never fails and never halts.

```ts
observe("resolved", await workspace.tests.pass())
observe("collateral", (await workspace.changed()).length - 1)
```

A model that fails every single trial is a finding. It is very often the finding. A
benchmark that reported itself broken because the thing it measured performed badly would
be useless for the exact comparisons it exists to make.

There is a second reason they cannot merge. `expect` throws on first failure:

```ts
expect(workspace).toPassTests()          // fails, throws
expect(workspace).toHaveChangedOnly([])  // never runs
```

You would lose every measurement after the first one — precisely on the runs where you
most want them. `observe` collects all of them, always.

## The rule

**`expect` guards the experiment. `observe` records the result.**

If you find yourself wanting `expect` to not-fail, you wanted `observe`. If you find
yourself checking that the agent did well, that is `observe`. If you are checking that the
benchmark itself is functioning, that is `expect`.

## Declaring what can be observed

What a benchmark records is a TypeScript type:

```ts
type Schema = {
    /** Has the agent resolved the bug? */
    resolved: boolean

    /** Files edited beyond the target. @objective minimize */
    collateral: number

    /** Strategy the agent took. */
    approach: "refactor" | "patch" | "rewrite"
}

export default defineBench<Schema>({ ... })
```

A type, not a config block, because a type is the right tool for the job. A doc comment is
where a description naturally goes. A union is how anyone would write a fixed set of
categories. And the moment you model types in JSON, you are building a worse TypeScript
inside your config file.

Everything is derived from it:

| From | To |
|---|---|
| property name | the measurement id |
| property type | boolean, number, or category |
| doc comment | what it means to a reader |
| `@objective minimize` | which direction is better |
| `@unit ms` | display suffix |

`observe("resolved", true)` is checked against this. A typo in the id is a compile error,
not a silent gap discovered later when the leaderboard has a hole in it.

Aggregation defaults from the type — booleans aggregate as a rate, numbers as a mean,
categories as counts — and can be overridden per measurement when the default is wrong.

## Why the schema is not only a type

Types vanish at compile time. This one is extracted during `axon prepare` and written into
the run manifest, because two things need it at runtime:

**Coverage.** A benchmark can only report "expected four measurements, observed three" if
it knows the fourth exists. A measurement that never fired is invisible unless it was
declared.

**Comparability.** Results from different people enter a shared aggregate only if their
schemas match. The manifest carries the schema hash; a benchmark that changed what it
measures is a different benchmark, and results across the change should not be silently
averaged.

You write a type. The system keeps a value.

## Objectives, and only where needed

`@objective minimize` is on `collateral` and not on `resolved`, because more resolved bugs
being better is obvious and fewer touched files being better is not.

Direction is the one thing that genuinely cannot be inferred. Everything else — the type,
the id, how to aggregate — follows from what you already wrote.

## Evidence beyond numbers

Some things are not scalars. `attach` stores them as content-addressed artifacts on the
run:

```ts
await bench.attach("diff", await workspace.diff())
```

Deduplicated by hash, referenced from the trial that produced it, and available when
someone asks *why* a cell scored the way it did. A number tells you which model won; the
diff tells you what it actually did.

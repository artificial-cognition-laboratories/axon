---
title: Structured Output
---

# Structured output

Sometimes you don't want prose back. You want an object, with the fields you asked for,
that your code can use without parsing anything.

```ts
const result = await axon.request({
    prompt: "audit src/ and report every issue you find",
    output: "{ files: number, issues: { file: string, line: number, message: string }[] }",
})
```

`output` is a TypeScript type, written as a string. That single string does three jobs:
it is checked before the model is called, shown to the model as its target, and enforced
against what the model produces.

## Why TypeScript and not a schema library

The agent's whole world is already TypeScript. Every tool it can call arrives as a
`declare` block in its context window. Adding zod or JSON Schema would mean a second type
language in a system that already renders one — something new for you to learn, a
dependency shipped into every agent, and a translation layer between the shape you wrote
and the shape the model reads.

So there is no schema library. You write the type. The model sees exactly that type,
in the same language as its tools. And if you already use zod or arktype, they can both
emit a TypeScript type — so you are not locked out, you just don't have to be locked in.

## The two forms

A **type expression** covers most cases:

```ts
output: "number"
output: "string[]"
output: "{ ok: boolean, count: number }"
```

**Declarations** are how you express a shape that repeats or nests. Name the target
`Output`:

```ts
output: `
    type Issue = { file: string, line: number, message: string }
    type Output = { issues: Issue[], summary: string }
`
```

Your own type names are what the model sees, and what appears in any error — so name them
the way you would in real code.

## Checked before the model runs

An invalid type throws immediately, at your call site, before any inference is spent:

```ts
await axon.request({
    prompt: "...",
    output: "{ files: nubmer }",   // throws: Cannot find name 'nubmer'
})
```

This is what makes `output` a guarantee rather than a hint. A typo costs you a stack trace,
not three model calls and a confusing retry loop.

Because the check runs against the agent's live scope, an output type can also reference
types the agent's own tools declare:

```ts
// src/tools/files.ts declares FileEntry
output: "{ entries: FileEntry[] }"
```

## How the agent produces it

The agent builds the object in its `<script>` block as ordinary TypeScript, then hands it
over whole:

```vue
<script>
const entries = await files.list("src")
const result = { files: entries.length, issues: [] }
</script>

<template lang="json">{{ result }}</template>
```

The value is **serialised, never typed**. The model never writes JSON syntax by hand — no
braces, no commas, no quoting — so the result is valid however large or deeply nested it
gets. A ten-thousand-item array is one interpolation.

This is why a JSON template must contain exactly one interpolation and nothing else.
Hand-written syntax around a value would forfeit the guarantee, so the runtime rejects it
as a format error rather than emitting something that might not parse.

## Enforcement and retries

After the model writes its script, the runtime typechecks it against your type — before
running it. A mismatch comes back to the model as a real TypeScript diagnostic:

```
line 3: Type 'string' is not assignable to type 'number'.
```

Models correct that reliably, far more so than schema-validator prose. The model rewrites
its script and tries again.

```ts
const result = await axon.request({
    prompt: "audit src/",
    output: "{ files: number }",
    retries: 3,   // default 2 — at most 3 model calls
})
```

`retries` counts attempts *after* the first. When the budget runs out the request throws
with the accumulated diagnostics. It never returns a value that failed its check — a
caller that asked for a shape gets that shape or an error, never an unvalidated object it
would treat as validated.

Two details that matter:

**The script is checked before it runs.** The script is real code that touches the world,
so one that cannot satisfy the contract never executes. Otherwise every retry would
double its side effects.

**A failed check overrides `<done/>`.** A model that declares itself finished while
producing the wrong shape has not finished.

## What this does and does not guarantee

TypeScript proves a program is well-typed. It does not, by itself, prove a runtime value
has a shape — the language has two deliberate ways for well-typed code to lie about a
type. Both are rejected while an `output` type is in force:

**Assertions.** `as T`, `<T>x` and `satisfies T` all tell the checker to believe a claim
it never verified — `JSON.parse(x) as Output` is perfectly well-typed and can produce
anything. `as const` is still fine: it narrows rather than widens.

**`any`.** The wider hole in practice, because nobody writes it — it arrives from a
loosely typed tool. If `db.query()` returns `Promise<any>`, that value flows into
`result` and every check succeeds *vacuously*, since `any` is assignable to everything.
So the runtime asks the checker what `result` actually resolved to, and rejects it if
`any` is anywhere in the shape.

The fix the model is told to make is to narrow:

```ts
const rows = await db.query("select ...")
const result = { rows: Number(rows) }   // now genuinely checked
```

`unknown` is not affected — it is assignable to nothing without narrowing, so it already
fails with an ordinary type error.

With those closed, a value reaching `result` has a shape the checker genuinely verified.
What remains outside its reach is anything TypeScript cannot see: this is output parsing,
not a sandbox. The capsule and OS permissions are what contain what an agent can *do*.

## Streaming

`output` works on `axon.stream` too, and enforces exactly the same contract —
`request()` is `stream()` drained, so a shape can never be demanded of one and skipped
by the other.

```ts
const run = axon.stream({
    prompt: "audit src/",
    output: "{ files: number }",
})

for await (const entry of run.stream) {
    // tool calls, results, output — the work as it happens
}
```

What differs is *when* you learn the contract failed. A stream yields entries as they
occur, so you watch the agent work; if the budget is then exhausted, the iteration
**throws** at your `for await`. The failure event is yielded immediately before the
throw, so a consumer watching the stream sees the cause first.

That is the tradeoff to weigh:

- **`request`** — one value, or an error. Nothing to handle mid-flight.
- **`stream`** — live entries, but you must be ready for a throw at the end.

Note the final value itself is not incremental: a JSON template is a single
interpolation, so the shape arrives whole in one entry rather than assembling across
several. Streaming buys you the *work*, not a partial object.

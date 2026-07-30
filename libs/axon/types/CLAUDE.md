# @arcforge/types — The Contracts

## What This Is

Every shape that crosses a boundary in Axon. Types only — no behavior, no
runtime beyond a handful of pure predicates that must not fork (`classifyEvent`,
`isSpanStart`, `readSession`). Published, and depended on by every other
package: `@axon/core`, `@arcforge/kernel`, `@arcforge/cognet`, `@axon/capsule`,
`@arclabs/cloud`, the TUI, the backend.

The dividing question for any file: *is this a contract two things agree on, or
is it one thing's implementation?* Contracts live here. `AxonError`'s shape is
here; `err()`'s stack capture is in `@arcforge/err`.

## The Event Ontology

`src/session/` is the largest thing in this package and the one with real
invariants. It defines every event the runtime can emit.

### One log, one writer, one total order

A session is a single JSONL file. `Writer()` in `@arcforge/session` serializes
every append, so **disk order IS commit order** and `time.seq` is authoritative
ordering, immune to clock skew. The scheduler admits **one wake at a time**.

These two facts are load-bearing for everything below. They are why distributed
tracing is redundant here and why nesting can be recovered exactly.

### The envelope

`envelope.ts`. Five rules, and they hold:

1. Call sites emit `(type, data)` only. `id`, `time`, `context` are stamped in
   exactly one place — the session's `envelope()`.
2. Correlation lives in `context`, never in `data`.
3. Classification comes from the type namespace, not a `source`/`layer` field.
4. Failure payloads carry the full `AxonError`.
5. Ingest-time fields (`receivedAt`, `userId`) are a backend wrapper.

`context` is `runId` + `spanId`. **There is deliberately no `traceId` or
`parentSpanId`** — `runId` already is the trace id, and there is no span tree
to build.

### Spans

Every bracketed operation declares through `AxonSpan<>` (`events/span.ts`),
which generates `:start` / `:complete` / `:failed`, plus `:interrupted` via
`AxonCancellableSpan<>`. A family cannot ship a missing half — that is a
compile error, not a review finding.

`durationMs` is added to **both** ends by the helper. A failed operation still
took time, and "blew up after 30s" is a different problem from "blew up
instantly".

Two documented exceptions to `failed: { error: AxonError }`, both substituting
rather than extending the payload:
- `kernel:run:failed` carries `{}` — `err()`'s sink already committed the
  canonical `axon:error` at the throw site.
- `kernel:engine:failed` carries `AxonEngineFault` — a richer domain shape that
  drives the retry loop.

**Interrupted is not failed.** Cancellation is a settled outcome and must never
render as an error.

**Not everything is a span.** `capsule:tool:unloaded` is a synchronous delete.
`capsule:proc:denied` means nothing was ever spawned, so there is no bracket to
close. `axon:install:not-found` is a third settled outcome. `axon:session:*`
uses `opened`/`restored`/`closed` precisely *because* it is not a span — a
session outlives the runtime, so `:start` would read as a bracket that never
closes.

### Classification

Three read projections, derived from the type namespace — never a storage fact:

| View | Contents | Audience |
|---|---|---|
| `entries` | `cognet:stimulus/output/action:*`, `axon:interrupt`, `axon:system:*` | cognition + clients |
| `kernelLog` | `kernel:*`, `cognet:*`, `capsule:*` | devtools, flame graph |
| `log` | `axon:*`, `module:*` | humans |

`classifyEvent()` is the one definition. Anything routing an event derives from
it. Carve-out: `capsule:attach`/`detach` are runtime continuity facts, so they
land in `log` despite the namespace.

### Durability

Everything commits **except** the byte streams in `CAPSULE_TRANSIENT_EVENTS` —
the one canonical list. A command's stdout already reaches the durable record
folded into `cognet:action:result`.

### Reading it back

`readSession()` (`read.ts`) rebuilds the nested tree by bracket-matching within
`seq` order: a span's parent is the innermost span still open when it started.
Given one writer and one wake this is exact, not a heuristic — which is the
whole reason no parent pointer is emitted. `formatSession()` renders it.

## Key Interfaces

```ts
AxonEvent<M, K>              // the envelope — id, type, time, context, data
AxonSpan<Name, S, C, F>      // generates a :start/:complete/:failed triad
AxonCancellableSpan<...>     // + :interrupted
AxonEventMap                 // every event that can reach a log or the bus
classifyEvent(type)          // → "entries" | "kernelLog" | "log"
readSession(events)          // flat log → nested span tree
foldChunks(entries)          // the chunk-assembly rule, one implementation
```

## Invariants

1. Every bracketed operation declares through `AxonSpan<>`.
2. Every declared event has at least one emitter. A declared event with no
   emitter is a lie in the contract — delete it or wire it.
3. Failure payloads are structured, never a bare string.
4. `context` carries `runId` + `spanId`. Nothing else correlates.
5. Hierarchy is bracket-matched, never a parent pointer.
6. One stamping point for the envelope.
7. Durable/transient derives from `CAPSULE_TRANSIENT_EVENTS`.
8. Classification derives from the type namespace via `classifyEvent`.

`core/tests/integration/ontology/spans.test.ts` asserts 1, 3, 4 and 5 against a
live runtime. It fails if a future change opens a span it never closes, ships a
completion with no duration, or invents a bespoke lifecycle verb.

## Known Debt

- **The capsule's error shape is duplicated.** Guest code (`src/process/**` in
  `@axon/capsule`) cannot import `@arcforge/err` — the workspace symlink points
  out of the confined filesystem, so the subprocess dies at startup with ENOENT.
  It builds `AxonErrorJSON` by hand in `src/process/fault.ts`, with seven error
  definitions inlined. Codes are the join key across the pipe; they can drift.
  The import restriction itself is now enforced by
  `capsule/tests/confine/guest-imports.test.ts`, which fails in milliseconds on
  a runtime import instead of letting a real subprocess die at startup. The
  payload duplication remains — it is the price of the boundary.
- **Guest-side errors carry no `frames`.** Structured frame capture reads source
  off disk, which confinement prevents. The raw `stack` string still crosses, so
  location isn't lost — only the pre-parsed presentation.
- **ECS telemetry is the highest-volume event source by construction.** Every
  component write commits durably. Acceptable while `Ecs()` is opt-in and
  unconstructed; whoever wires the first continuous world should measure it and
  gate at the write if it bites. Do not quietly route it bus-only.
- **`test.ts` and `bench.ts` use their own vocabulary, deliberately.** They are
  SEPARATE observability domains, not part of the agent event ontology: neither
  is in `AxonEventMap`, each carries its own context (`testRunId`,
  `benchRunId`), and each writes its own log. The flame graph never sees them
  and every consumer matches exact literals rather than suffixes — so the
  argument that forces `AxonSpan<>` elsewhere (a bespoke verb is invisible to a
  suffix-matching reader) does not apply. `test:case:{pass,fail,skip,todo}` is
  a four-outcome result vocabulary, which a three-state span cannot express
  honestly; renaming it would be churn.

  What WAS a real defect — `bench:cell`/`bench:trial` opening brackets that a
  mid-loop throw never closed, which the projection then silently dropped —
  is fixed: both now emit `:failed` and close their own span before
  propagating. If either map is ever folded into `AxonEventMap`, revisit the
  naming then; until then their shape is correct for their own readers.

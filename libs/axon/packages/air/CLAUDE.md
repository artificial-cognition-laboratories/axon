# @arcforge/air — The Agent Intermediate Representation

## What This Is

The protocol a model is spoken to in, and understood by. One grammar, two
halves: **render** turns domain objects into the messages a model sees, and
**parse** turns its reply back into blocks. Both live here so they cannot
drift.

Published, and depended on by everything that talks to a model. It depends on
`@arcforge/types` and nothing else — no kernel, no cognet runtime, no session.
That is what lets both sides of the runtime use it without either depending on
the other.

**Why it is its own package.** It used to be a subpath of `@arcforge/cognet`,
on the reasoning that "AIR is a cognet's choice, not the platform's". That was
already false — `kernel/src/engine.ts` picked the AIR parser for every call —
and it forced ring 0 to import the runtime it loads, an inversion the kernel's
own doctrine forbids. AIR is about *models being called*, which is neither
brain nor kernel: it is the standard both speak.

## The Design

**Input is cognition; output is service.** This split is the reason the
package has two halves, and it decides who uses which:

| half | used by | why |
|---|---|---|
| `render` | the cognet | What the model sees — identity, scope, which history, elided how — is the whole lever on how a model behaves. It belongs to the brain, where injection, compression and retrieval live. |
| `parse` | the kernel | Once the model has replied, turning that reply into committed facts is mechanism with no decision in it. The kernel owns the model service, so it owns that. |

Neither half knows the other's consumer. AIR never imports a kernel type and
never learns what a cognet is.

**The render boundary is DOMAIN in, messages out.** Callers pass `AxonScope`
and `AxonEntry[]` — what they already hold — never AIR's internal render
vocabulary. The timeline item shapes are private to `render/`, next to the
parser they must agree with.

**A protocol is one named grammar, resolved as a unit.** `protocol/` owns the
meta prose, the mode list, the contract rules, and the examples together,
because they cannot be chosen independently — a protocol's prose describes
the exact tags its mode list permits, so one is meaningless beside another's. `Air({
protocol })` swaps all four at once, and adding a protocol is adding an entry
to `PROTOCOLS`; nothing else in AIR branches on the name.

| protocol | grammar | for |
|---|---|---|
| `classic` | `<script>` computes, `<template>` speaks — INDEPENDENT blocks | any model that may act |
| `raw` | none — empty contract, no meta | internal one-shot calls: classification, ranking, extraction |

**One `<state>` tag, never a tag per concept.** Putting arbitrary data in
front of a model is a real and recurring need — a knowledge catalogue, a
world model, a goal stack, a percept summary. Giving each its own block
would grow AIR a renderer per concept and make it learn what each concept
MEANS, which is a domain opinion a format must not hold. It also makes the
model infer, per tag, whether it is reading stable belief or transient
record. One stable tag is an attention anchor learned once; `name`,
`description` and `lang` carry the variance, and the content is the caller's.

**State is timeless; the timeline is causal.** A belief three turns stale is
still the current belief, so recency is a field the cognet writes inside
`content`, never a timestamp AIR branches on to choose placement. A cognet
that wants an event in the causal record emits a stimulus — that path
already exists, and a primitive that rendered in two structurally different
places depending on its payload would be the accumulation failure in
miniature.

**Section order is a caching contract.** `meta → scope → contract` are
stable across turns and form the prefix a provider can cache; `system →
state → timeline` are the volatile tail, ordered least to most volatile.
`<system>` sits after `<contract>` for exactly this reason — `boot.vue` may
be Vuedown and re-render every call, and a volatile block inside the stable
head invalidates everything behind it.

**One vocabulary, whatever the protocol.** Every model response reduces to
the same two things: a structure it produced, and optionally the computation
it ran to get there. `<text>` was a template with `lang="md"`; `<typescript>`
was a script. Unifying the tags removed a per-protocol branch from the
timeline renderer, the parser, and the mock engine — none of which should
ever have known which grammar was in force.

**Blocks are independent, and that is a streaming decision.** A coupled
variant — a template interpolating bindings its own script produced — reads
well and fights streaming in practice: the template cannot render until the
script has closed AND run, so nothing can be shown until everything is
finished, and whoever suspends in the middle needs the parser and the capsule
at once. Every placement of that suspension crossed a boundary: into
cognition, into ring 0, or into a library an author must remember to apply.
The idea is good and belongs in a cognet that wants it, not in the protocol
every other model pays for. (It existed here as `sfc`, with an `Interpolate()`
renderer; both were removed rather than left half-wired.)

**Turn completion is a declared signal (`<done/>`), not a derived one.**
Deriving it structurally is the design we wanted and it does not work:
"I see the issue, it's in the loader" and "the fix is deployed" are the same
shape — one template, no script — so no reduction over what a response DID
separates a progress report from a final answer, and a loop that guesses
stops the first time a model narrates between actions. So the model is asked.
The runtime treats the answer as a signal a loop may weigh, never an
instruction it obeys. See `DONE_RULE`.

**The kernel parses; it never acts.** A `<script>` block is reported, never
run. Running code is an act and acts belong to the brain — the kernel is the
authority on HOW code runs (policy, capsule, commit), never on WHETHER a
given reply should have run any. That line is what keeps the service general:
a cognet may call a model to classify a stimulus, rank an inference or plan,
and if the runtime ran whatever came back, every one of those would touch the
world unasked.

## Key Interfaces

```ts
Air(opts?)                      // render + parse, one resolved grammar
Output({ scope })               // compile a declared output type, then enforce it
renderScope(scope, output?)     // the <scope> block — also used by CLI typegen
scopeToDts(scope)               // the same scope, spelled for tsc
```

`renderScope` is exported because typegen must render the SAME scope the model
is shown: if the editor's `.d.ts` and the `<scope>` block disagreed, the editor
would describe capabilities the model does not have. One renderer, two
consumers, no second implementation to drift.

## Versioning

Published in lockstep with `@arcforge/types`, `@arcforge/err`,
`@arcforge/engines`, `@arcforge/cognet` and `@arcforge/kernel` by
`apps/tui/scripts/release.ts`. It publishes after types and before the kernel
and cognet, since both depend on it.

## Structured Output

A caller may declare the shape a response must have, as a TypeScript type
(`request({ output: "{ files: number }" })`). One string does three jobs and
they cannot drift, because all three read the same compiled artifact: it is
checked before the model is called, rendered into `<scope>` beside the tools,
and enforced against the model's own `<script>`.

The schema language is TypeScript itself rather than a schema library. The
agent's whole model-facing surface is already `declare` blocks, so a library
would be a second type language plus a dependency in a package installed into
every agent — and every schema library can already emit a TS type.

**TypeScript is not runtime-sound**, so the check proves the model's code
*claims* the shape rather than that the value has it. The reachable escape
hatches are closed while a contract is in force: `as`/`<T>`/`satisfies`
assertions are rejected (`as const` is allowed — it only narrows), `any`
reaching `result` is rejected by asking the checker what the binding resolved
to, and a `result` that is reassigned or merely `declare`d is rejected. What
remains is outside a typechecker's reach; this is output parsing, and the
capsule is what contains what an agent can *do*.

`Output()` lives here rather than in the kernel because it is entirely an
output concern: it renders a declaration into `<scope>` and checks the script
the model wrote against it. Neither half is cognition, and it depends only on
`typescript` and `AxonScope`.

Enforcement and its retry budget live in the kernel's engine (`stream()`): a
response that misses its shape is discarded and re-requested with the
diagnostic committed, so the model reads its own TypeScript error and rewrites.
On exhaustion the call fails loudly — a caller that asked for a shape gets that
shape or an error, never an unchecked value it would treat as validated.

## Known Debt

- **The prose is guarded by assertion, not by construction.** `MODE_DEFAULTS`,
  the contract rules and `CLASSIC_META` all describe the same grammar in three
  places, and nothing but `tests/render/sections.test.ts` stops them drifting
  apart. That test exists because they DID drift — the meta outlived two tag
  renames and a removed yield tag, teaching every model a grammar the parser
  no longer spoke. A generated contract would be better than a guarded one.
- **`raw` renders no contract at all**, so a caller wanting structure without
  an execution environment (a classifier that must return a declared shape)
  has no protocol that fits: `classic` hands the model a capsule it did not
  ask for. Worth a `prose` protocol — text mode, full contract, no script —
  the day something actually needs it.

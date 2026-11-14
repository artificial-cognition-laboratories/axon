# Locus — the idea

An informal, working record of what this primitive is, why it takes the shape it does, and
where it is meant to go. Not a formal paper. A substrate for thinking about it outside one
person's head, meant to be edited as understanding changes.

**This is the reasoning. [`README.md`](./README.md) is the contract.** If something here could
live in either, it belongs in the README and this file should link to it.

Every section is marked:

| | |
|---|---|
| `BUILT` | implemented and tested in this package |
| `DESIGNED` | decided and specified, not written |
| `OPEN` | a known problem with no answer yet |
| `BET` | a claim about cognition, with its evidence stated |

Part I stands on its own. **Nothing in Part I depends on Part II being right.**

---
---

# Part I — The primitive

## 1. What it is · `BUILT`

An **axis** is a named, graded property. A **coordinate** is the degree to which one thing holds
every axis in the space.

Formally: each axis is a fuzzy set (Zadeh, 1965), and a coordinate is a point in the unit
hypercube `[0,1]^N` of their product. Membership degree used as a **storage address** rather than
as a predicate — that is the whole move.

One word separates it from an embedding:

| | dimensions | example |
|---|---|---|
| **latent** | emerge from training, uninterpretable | any embedding |
| **manifest** | specified and named in advance | this |

The space is **never rotated.** Rotation mixes axes into linear combinations that no longer have
names — which is exactly what PCA and embedding training do, and exactly why their dimensions
cannot be read. Projection (dropping axes) is allowed and cheap; rotation would destroy the only
property that matters.

> **An embedding you can read — and query like a database.**

### Not "symbolic"

A symbol, in cognitive science, is a discrete token whose identity is arbitrary relative to its
referent, manipulated by rules that never look inside it. A coordinate is neither discrete nor
arbitrary, and its parts mean things. It is a **distributed representation** — but an unusual one,
because the dimensions are individually interpretable.

The accurate description is a **conceptual space** (Gärdenfors, 2000) whose points are attribute
vectors: **sub-symbolic, but interpretable.** Saying "symbolic" makes specialists picture Prolog
and everything after that mismatches.

---

## 2. What it cannot represent · `BUILT`

Second, deliberately. The boundary is what makes the rest worth believing.

| cannot represent | belongs in |
|---|---|
| **role binding** — who did what to whom | a propositional store, or accept the loss |
| **relations** — `wood CRAFTS_INTO plank` | an edge table beside the space, never an axis |
| **dimensioned quantities** — 20 dps, 3 m | `payload`; the coordinate holds the normalised projection |
| **counts** — "three zombies" | `payload` |
| **ambiguity between two modes** | two candidate coordinates |
| **sequence** | `trajectory`, not a point |
| **time, ids, recency** | filters and fields |

### The binding limit, stated exactly

```
"the fox jumped over the wall"     →  { has-fox: 1, has-wall: 1, motion-jump: 0.9 }
"the wall jumped over the fox"     →  { has-fox: 1, has-wall: 1, motion-jump: 0.9 }
```

Identical. A bag of graded properties loses **role binding**, and no number of axes fixes it —
this is the classic symbol-binding problem. Decomposing the fox into `is-animal, can-jump` is the
right move *within* the space, and it is the same move that throws away the syntax.

Where binding lives, if it is ever needed: Vector Symbolic Architectures bind with elementwise
complex multiplication, where **phase** carries the role assignment (Plate, HRR). The price is
every bit of interpretability, which is why it would be a separate mechanism beside this one, not
a replacement for it.

### The relation trap

The tempting mistake, stated so it is recognisable:

```ts
// WRONG — a relation wearing an axis costume
{ "crafts_into_chest": 0.9 }
```

It works for one entity, then you need an axis per target, dimensionality goes to N², the axes
become catastrophically non-orthogonal, and every similarity is dominated by relation-axes. The
mechanical test:

> **If an axis name references another specific entity, it is a relation. Put it in an edge table.**

### One more subtlety

A coordinate at `{ tool: 0.5, weapon: 0.5 }` is indistinguishable from "moderately both". A single
point expresses **partial membership**, never **uncertainty between alternatives** — and confidence
does not rescue it, because high confidence in 0.5 still means *genuinely halfway*. If the
distinction matters, store two candidates and let them compete.

### It is an index, not a compression

You cannot reconstruct a record from its position. Payload is stored beside the coordinate. And
nothing here is learned: the space cannot notice that two axes are redundant or that a needed one
is missing. That is what [§7 statistics](#7-consolidation--built--open) and
[§13 bisimulation](#13-the-bitter-lesson-fork--open) are for.

---

## 3. Why named axes · `BUILT`

Not because named is nicer. Because **one representation does the work of nine normally-separate
subsystems**, and a dense embedding gives you exactly one row of this table:

| operation | normally | embedding can? |
|---|---|---|
| storage at a coordinate | a database | — |
| predicate query | a search index | — |
| nearest neighbour | a vector store | **yes** |
| categorisation | a classifier | — |
| concept formation | a clustering job | — |
| novelty | absence-of-record, badly | — |
| anomaly | a separate detector | — |
| bias / direction | a bespoke goal system | — |
| temporal structure | nothing, usually | — |

That is a load-bearing collapse, not a convenience. And it is available *only* because the axes
are named.

### More axes are more doors into the same memory

Measured, twice: `recall@1` rises with axis count (0.750 → 0.800 → **0.888** at 24 / 72 / 144 axes,
50k records) and with the number of *discriminating* axes (0.41 / 0.76 / 0.87 / **1.00** at 3 / 6 /
12 / 40). Each configuration carried distractors scaling with it, so this is net of the noise they
add.

The mechanism is that many named axes are an **error-correcting code**. Any individual axis may be
mis-assessed — a producer puts a thing slightly in the wrong place on one dimension — and the other
axes outvote it. So assessment noise, which is the thing most likely to go wrong in practice, is
absorbed by richness rather than by better producers.

It is also the property that makes the thing behave like associative memory. A sparse memory has few
cues and cannot be reached deliberately; a richly encoded one can be entered from any of its
attributes — a smell, a key change, a time of day. **Each axis is another door into the same
record.** That is the encoding-specificity principle (Tulving & Thomson, 1973) falling out of the
representation rather than being designed in.

The practical inversion is the important part:

> **The constraint on how large the space can get is measurement, not geometry.** Every axis is a
> question something must answer for every item. The metric tolerates far more axes than a producer
> can afford — so be generous with axes, and treat pruning as an optimisation rather than a
> necessity.

### Inspectability is a correctness property

Not a nicety. `difference(goal, current)` returns **words**:

```ts
difference(space, resolved, current)
// [ { axis: "tests:passing", gap: 0.9 },
//   { axis: "lint:clean",    gap: 0.4 } ]
```

A readable account of why something matched, and what a situation lacks to resolve. By the
repo's own standard — *tracing gaps are first-class bugs, untraced code is undebuggable code* —
an opaque memory is an untraceable path through the most important part of a mind. A manifest
space is the version of that subsystem that can be traced.

---

## 4. The geometry · `BUILT`

### Queries have shapes

| query | shape | index |
|---|---|---|
| predicate (`> 0.7`) | **box** — axis-aligned, crisp faces | per-axis scan; cheap |
| similarity (`near x`) | **ball**, or ellipsoid once domains are weighted | distance scan |
| region / concept | **convex region**, approximated by the above | prototype + radius |

Constraining 2 of 60 axes does not give a small box — it gives a **slab**, bounded on two axes and
spanning 0→1 on the other 58. Which is exactly what "don't care" means. Genuinely non-convex
shapes come from the *union* of several boxes, and that is where convexity dies.

### The query is crisp; the position is not

A coordinate is a **point estimate with error**. The true membership is unknown; `0.7` is a guess.
So every stored item is honestly a distribution, while the query boundary is a hard threshold —
which means **a crisp threshold over uncertain positions gives a soft result whether you designed
for it or not.** An item at `0.69 ± 0.15` is excluded by `> 0.7` despite being more likely than not
to satisfy it, and a conjunction over five axes multiplies five boundary coin-flips.

Two consequences:

- `confidence` is structurally necessary, not decorative — it is the width.
- **Prefer ranked results to hard cutoffs.** Use a threshold to truncate a list, not to decide
  membership. Same information, no cliff at the boundary.

### Domains exist for three independent reasons

All three want the same structure, which is usually a sign the structure is real:

1. **Orthogonality.** Hand-authored axes are never independent — but the harm is narrower than it
   looks, and it is *measured*. Writing `threat`, `danger`, `hostile`, `looming` counts one concept
   four times, and that has **no detectable effect on ranking** while other axes still carry the
   distinction. What it does is close the *margin* between "same concept" and "different concept" —
   so `near()` is safe and **thresholds are not**. See [§11](#11-what-the-lab-measured--built).
2. **Magnitude.** Some questions need it (`wary` vs `terrified` must not compare as identical →
   euclidean); some need only shape (a big fast thing and a small fast thing are alike in *form* →
   cosine). The metric belongs per group.
3. **Dimensionality.** In high dimensions all pairwise distances converge and discrimination dies.
   Distance is therefore never computed across 200 axes at once — only within groups of 5–15, then
   combined by weight.

### The measured-intersection rule

The one line of maths that had to be right first time.

```
d(a, b) over { i : conf_a[i] > 0 ∧ conf_b[i] > 0 }, normalised by |that set|
```

Because appending an axis is deliberately free, old coordinates carry `conf = 0` on it and new ones
do not. A metric treating unmeasured as zero would silently shift **every existing pairwise
distance** the moment the ontology grew. You would see rankings change after an addition with no
data change, and it would take a long time to work out why.

> There is a test asserting exactly this: appending an axis leaves existing distances unchanged.

The rule holds for *appending*, and it is not sufficient for *sparsity*. Normalising by the compared
count makes a 4-axis comparison and a 40-axis comparison both land in `[0,1]` with nothing marking
which is the thinner claim — and lab `e4` measured `recall@1` collapsing to 0.165 as a result. Each
domain is now weighted by its completeness, which is identity at full coverage and necessary below
it; the residual problem is described in [§11 finding 6](#11-what-the-lab-measured--built).

### No overlap throws

`distance()` on two coordinates sharing no measured axis **throws**. Zero similarity and an absence
of comparison must never be indistinguishable to a caller ranking results. `explain()` is how you
*ask* — it reports `compared: 0` and `NaN`, so a caller reading `.distance` while ignoring
`.compared` gets a value that poisons every comparison instead of a plausible "identical".

The archive returned `0` here. That was the bug.

---

## 5. The algebra, and the one place we diverged · `BUILT`

`ops.ts` in the archive was a rediscovery of fuzzy set algebra. Good news — sixty years of worked
results sit behind it. It also diverged from the standard operator in exactly one place, and the
divergence had a visible consequence.

### t-norms are the valid ANDs

```
min           Math.min(a, b)              the bottleneck
product       a * b                       both must genuinely hold
lukasiewicz   max(0, a + b - 1)           strictest
```

What makes one legitimate is the boundary condition `T(a, 0) = 0`. **Average fails it:**
`avg(0.8, 0) = 0.4` — half-presence conjured from an absence.

### The consequence, worked

The archive used an averaging `intersect` for pattern matching:

```
pattern = { a: 1.0, b: 1.0 }     current = { a: 1.0, b: 0 }

average → { a: 1.0, b: 0.5 }  →  score 0.75  →  "74% match, getting close"
min     → { a: 1.0, b: 0   }  →  score 0.50  →  correct
```

Half the pattern is unsatisfied and it reported three quarters. Any intervention keyed on that
threshold fired early, on a pattern with an unmet condition, forever.

### The fix was a rename plus a missing function

The diagnosis was subtler than "use min". `intersect(a, b)` took **two symbols** and averaged
shared keys — which is a *restricted centroid*, and the average is correct for that. It simply is
not a set intersection, and naming it one is what led to it being used as an AND.

```
commonality(a, b)              "what is typical of both"      — the average, correctly named
match(pattern, position)       "how well does this hold"      — the function that was missing
conjunction(a, b, { tnorm })   "how much is both true"        — a real t-norm
```

### Two operations share one word

The confusion worth naming permanently:

| | operates on | example |
|---|---|---|
| fuzzy AND | **one item's** memberships | `min(x.noisy, x.interactive)` |
| set intersection | **two collections** | items in box A ∩ items in box B |

The Venn picture fits the second. The first needs a different picture: one point, combining its own
coordinates. Set-theoretic naming therefore belongs on `Region` — a region *is* a set — and never
on the store.

### Multiplication means logic, not physics

`a · b` on memberships is the product t-norm: a conjunction. Division has a meaning too (Goguen
implication — "to what degree does a entail b"). What multiplication does **not** give you is
arithmetic on quantities:

> **Axes are coordinates in a space, not variables in an equation.** A vector space offers adding
> two vectors and scaling one. It has no product of two *components*. Structures that do are
> algebras — which is what complex numbers and quaternions are, and why they are a different kind
> of object rather than a bigger one.

Computation goes in the payload. Logic goes in the coordinate.

---

## 6. `Region` — one type, five jobs · `BUILT`

| as | operation |
|---|---|
| a **kind** | the nearest region claims the point |
| **novelty** | *no* region claims the point |
| a **consolidation target** | the centroid absorbs its members |
| a **goal state** | distance to it, plus `difference` for the named gaps |
| a **behaviour precondition** | containment decides whether it applies |

Five distinct jobs, one type, one threshold. The collapse appearing this many times is the argument
that this is a primitive rather than a convenient data structure — and it makes `Region` the centre
of the package, with `Coord` as the thing it is made of.

### Identity, novelty and formation are one mechanism

```ts
const claims = locus.regions.claims(position)
// [] → nothing is like this. Open a region: concept formation.
// [{ region, distance }, …] → recognition, nearest first.
```

`encounters === 1` in an ECS means *never seen this thing*. Here the same idea generalises to
*never seen anything like this* — because novelty became a **distance** instead of a counter.

### Prototypes are plural on purpose

If *building block* is really wood-like **and** stone-like, a single centroid lands **between** the
clusters, in empty space, matching neither. Membership is the best over prototypes, and a member too
far from all of them opens a new one — the same operation as formation.

### A radius is fitted, never chosen

`fit()` derives the radius from its members — `mean + 2·sd` of member-to-prototype distance —
because a constant cannot know about the axis table, the domain weights or the metric. Measured: the
same-vs-other margin shrinks **20–46%** as redundant axes are added, with `recall@1` completely
unmoved. A hand-chosen radius therefore over-claims the moment the space grows, and **novelty
detection degrades with no symptom in retrieval** — the worst failure shape available here, because
nothing downstream can tell a wrong answer from a right one.

`DEFAULT_RADIUS` survives only for a region opened from a single seed, where there is nothing to
measure yet.

### Membership is graded; commitment belongs to the caller

`membership()` returns `[0,1]` and never decides. That is what lets a consumer adopt a name on one
threshold and abandon it on a lower one — hysteresis a region that decided for you could not
support.

It decays exponentially (`e^(-c·d)`, Shepard's universal law of generalization) rather than as
`1 - d`, because this is one of the few places the distance *value* is consumed rather than sorted.
Note what that does not change: both are monotone in distance, so **`has()` and `claims()` rank
identically under either** — only a graded score can tell them apart. And it has a floor: maximum
distance generalises to `e^-c ≈ 0.05`, not to 0, so a threshold has to sit above that.

---

## 7. Consolidation · `BUILT` · `OPEN`

Everyone demos retrieval. Nobody demos ten thousand sessions of accumulation, and that is what
actually kills memory systems: monotonic growth with no principled way to compress or forget.

### Why geometry can do this and a graph cannot

| | coordinate space | knowledge graph |
|---|---|---|
| **insertion** | computed from the item alone — **local and context-free** | must decide which nodes and edge types; a wrong choice makes the item permanently unreachable |
| **query** | any axis combination, composed at query time | traversal from known entry points along known edge types; an unanticipated question has no path |
| **forgetting** | deleting a point affects nothing | deleting a node can disconnect subgraphs |
| **consolidation** | **arithmetic with one knob**, monotone | deciding which edges survive — a judgement, so a model |

Insertion being local is the deep one: **writes never need reads.** It is what allows the write path
to be mechanical rather than deliberative.

### It degrades in the right direction

Precision is lost; **position is kept**. An old memory collapses toward its centroid, so the episode
fades while *something like this happened, in this region* survives. Episodic detail decaying into
gist is what human semantic memory does — and here it falls out of the mean rather than being
designed in.

```ts
const report = await locus.records.consolidate({ radius: 0.05, domain: "risk", slots: recent })
// { before, after, clusters, leaders, comparisons, truncated }
```

A prototype records what it absorbed, so a consolidated memory can still say what it was made of
after the episodes are gone.

### Never consolidate the whole store

The first implementation was pairwise — for each unclaimed row, scan every other unclaimed row. Fine
when a few large clusters absorb everything, quadratic when they do not, and **"many small clusters"
is precisely what an accumulating memory looks like.** Since consolidation is the headline argument
for this whole approach, that was the largest gap between what the design claims and what the code
could do.

It is now **leader clustering**: a single pass comparing each row only against the leaders found so
far, `O(records x leaders)` rather than `O(records²)`.

That bounds the cost; it does not remove it. The honest conclusion is the same one ranking reached:
**scope it.** `slots` takes the rows a query returned — everything added since last sleep, one
region's members — so the caller chooses the bound. Three things make that choosable rather than
guessable:

- **`comparisons`** is reported, so the cost is a number rather than an inference.
- **`maxLeaders`** is a guard, not a tuning knob. Leader clustering degrades toward a full pairwise
  scan exactly when nothing clusters — a radius slightly too tight, or genuinely diverse content —
  and that is the case where cost explodes silently. Hitting it sets **`truncated`**, so a partial
  consolidation announces itself rather than looking like a complete one that found little.
- **It is monotone.** A group of one is left alone, so running again at the same radius is a no-op.

One property to know: leader clustering is **order-dependent** — which row becomes a leader depends on
visit order. Slots are visited in insertion order, so a given store consolidates reproducibly, but two
differently-ordered stores of the same content can group differently.

### The missing number · `OPEN`

> **Compression ratio against region-level recall.** Consolidate 100k → 10k; what fraction of
> queries still land in the right region?

Nobody can state this for a graph or for an embedding store. It is the first legible number in a
space that has none, and it is the one measurement that would make the architecture argument
concrete rather than structural. `planConsolidation()` exists precisely so the curve can be measured
without destroying the original first.

---

## 8. What the geometry buys · `BUILT`

Each of these is a real operation, not an approximation. The point is not any single query — it is
that **filters, the metric and aggregation compose**, so questions nobody designed a feature for
become expressible.

### Composition nothing else does in one query

```ts
await locus.records.query({
    where: {
        "audio:emits":     { gt: 0.6 },
        "use:interactive": { gt: 0.5 },
        "risk:threat":     { lt: 0.3 },
    },
})
```

Noisy, interactive, not dangerous. No schema change, no anticipated edge type, no model. Every new
axis makes this stronger rather than more brittle, which is the opposite of how a graph scales.

### "What does an average Monday look like?"

Monday is **not an axis** — time is a filter. So the query is a filter and an aggregate:

```ts
const mondays = await locus.records.query({ when: mondaysIn(2026) })
const typical = centroid(space, mondays.hits.map(hit => hit.record.coord))
```

`typical` is a coordinate. It is readable — you can print what a typical Monday *is*, axis by axis.

### "How weird was this morning?"

```ts
const weirdness = distance(space, thisMorning, typical)
// 0.69 — significantly unlike a normal Monday
difference(space, typical, thisMorning)
// [ { axis: "user:frustration", gap: -0.6 }, … ]  ← and WHY
```

Anomaly detection and its explanation from the same two calls.

### "What about an average Monday breakfast?"

The composition that makes the whole thing worth building — narrow further, aggregate again:

```ts
const breakfasts = await locus.records.query({
    when: mondaysIn(2026),
    where: { "topic:breakfast": { gt: 0.6 } },
})
const typical = centroid(space, breakfasts.hits.map(hit => hit.record.coord))
```

Any filter composes with any aggregate. *Average Monday · average Monday breakfast · average
Monday breakfast when the user was frustrated* are the same operation with more clauses, and none of
them needed to be foreseen.

> `when: mondaysIn(2026)` is doing work the store does not yet support. `when` takes a range, so
> calendar predicates — day-of-week, hour-of-day, "every Monday" — currently have to be applied by
> the caller. This is the concrete argument for building the chronology leaf: it wants **calendar
> predicates, not just ranges.** `OPEN`

### "Is this situation drifting toward resolution or away from it?"

```ts
const t = trajectory(space, steps, { domain: "task" })
t.velocity()      // [0.05, 0.06, 0.81, 0.04] — a spike at step two
t.isLooping()     // revisiting ground already covered
t.isSettling()    // second half slower than the first
t.drift()         // ended far from where it started, or came back
```

Temporal structure with no model and no latency. Which is what lets an expensive deliberating layer
be called rarely — the cheap local answer handles "am I stuck" and escalates only when the geometry
says something genuinely unfamiliar is happening.

### "What is missing for this to be finished?"

```ts
difference(space, goalRegion.prototypes[0], current)
// [ { axis: "tests:passing", gap: 0.9 }, { axis: "lint:clean", gap: 0.4 } ]
```

A stop condition **and** a ranked todo list from one computation. A boolean check gives the first
and never the second.

One constraint, or this is self-deception: a goal region is Goodhart-able exactly to the degree the
agent authors its own axes. `user:content = 0.9`, self-assessed, is an agent grading its own
homework.

> **Goal-region axes must be grounded in producers the agent does not control.** Lint exit codes,
> test counts, sensor readings.

Note that this is the same constraint as *cheap and stable*, arriving from the safety side instead
of the cost side.

---

## 9. Storage · `BUILT`

### Not a vector store

| vector stores are for | this has |
|---|---|
| 384–4096 opaque dims | 60–200 named dims |
| **approximate** NN (HNSW/IVF) | **exact** |
| one metric over the whole vector | per-domain metrics and weights |
| no per-dimension predicates | **box queries are the primary query** |

ANN indexes exist for the case where you *cannot afford to scan*. Here you can. At 1M rows × 100
axes that is ~240MB of floats; a three-axis box query is sub-millisecond and a full similarity scan
is tens of milliseconds. An approximate index would trade exactness for a speed that is already
free — and it cannot do per-axis ranges at all.

What this actually resembles is a small **analytical column store**. Box query = predicate pushdown
on a column. Similarity = a windowed aggregate. Those are OLAP operations, which is the second time
the dimension/measure parallel appears.

### Quantised to 8 bits

Columns hold `Uint8Array`, not `Float32Array`. A membership degree comes from a rubric or a
probability estimate and does not carry seven significant figures of real information, so 256 levels
is ample — the step of 0.0039 is about 5% of the 0.08 margin the metric actually has to resolve.

What it buys is the difference between fitting and not: at a million rows and 200 axes, **1.6GB of
floats becomes 400MB.** Float32 precision was never an asset here either — it is what made a
`lte: 0.8` predicate exclude a row holding exactly 0.8.

Two details that matter more than they look:

- **Dequantisation goes through a 256-entry `Float32Array` lookup, never a multiply.** `coord()`
  writes into a `Float32Array`, so a dequantised value is f32-rounded; computing `level / 255` in f64
  anywhere else produces a different number, and the bulk ranker then disagreed with the reference
  metric in the last bit. The table returns the one float both paths must see. It is also faster than
  the multiply.
- **Predicates compare in quantised space.** A caller's `0.8` becomes `204` and is tested against the
  stored level directly — exact, no rounding of the stored side, no epsilon. This replaced the earlier
  `Math.fround` fix for the same class of bug. `eq` is the one predicate quantisation makes fuzzy: it
  matches a level, so it holds for any value rounding to that level.

### Writes are batched

`putMany` inserts under one transaction and `hydrateAll` fetches payloads in one query. Per-record
autocommit made a 50k load take 4.6s — roughly 90s for a million, which put every experiment above
that size out of reach — and a 100-hit result was 100 SQLite round trips. The cost was fsync and
round trips, not the inserts.

### Rows are durable; columns are derived

Coordinates persist one row at a time as float blobs. Writes are ordinary transactional inserts; the
columnar index is rebuilt in one pass at boot. The alternative — persisting the columns — rewrites a
multi-megabyte blob per put.

### Ranking is axis-major

A `near()` over 50k records × 144 axes costs ~45ms, down from 184ms before the loop was inverted.

`coord/distance.ts` is the reference metric and the right shape for comparing two positions. It is
the wrong shape for comparing one against fifty thousand: materialising a `Coord` per candidate is
row-oriented work over a columnar store. `store/rank.ts` walks **axes on the outside, candidates on
the inside**, so each column is traversed once, contiguously, accumulating partial sums for every
candidate at once — no allocation per candidate, no copies, direct typed-array reads.

That is the metric implemented twice, which is a real cost. It is bound to the reference by an
equivalence test asserting exact agreement on random inputs, across both metrics and on partially
measured rows. The test is the whole of what makes the duplication acceptable.

### `memory` and `sqlite` are one engine

They differ only in a persistence leaf. Which makes the in-memory substrate **not a mock**: a hot
test against it exercises the real planner, metric, regions and consolidation, with durability
removed rather than simulated.

`remote` is a different thing — it has no local engine at all, so it swaps the whole handle rather
than its persistence. Declared so `LocusHandle` is the one contract both paths satisfy and the
remote client can never drift from the local one; unwired, so it throws rather than pretending.

---

## 10. The basis lifecycle · `BUILT`

**Versioned, not mutable.** The system is dynamic; the space is stable between migrations. The
version is a content hash of the axes, so it cannot drift out of step with what it describes.

| change | breaking? | why |
|---|---|---|
| add an axis | **no** | append-only; existing coordinates get `conf = 0` on it |
| domain weight or metric | **no** | query-time, never stored |
| remove an axis | **no** | tombstone at weight 0; physical removal at compaction |
| **redefine a question, kind or levels** | **yes** | same name, different meaning — every stored coordinate was measured against the old one |

Growth and pruning are free. Only **redefinition** breaks.

### Degradation and versioning are separate mechanisms

The mistake worth recording: freely-proposed axes plus "migrate a memory to the nearest surviving
axis". Two reasons it fails —

- coordinates are expressed **in a basis**; if the basis drifts continuously, last month's rows stop
  being comparable to today's, and comparable history is the point of the store.
- `jwt-2.0 → jwt` is not a migration, it is a **re-assessment**. A value on a narrow axis does not
  determine a value on a broad one.

The separation that gives you what you wanted anyway:

```
degradation    CONTINUOUS   per-axis weight decays toward 0. No version change, no migration.
basis change   DISCRETE     a version bump, and a re-assessment from payload.
```

A dying axis stops influencing distance smoothly. That is the organic dissolving, without the space
melting.

### Migration is re-assessment, and that is newly affordable

Build beside, re-assess into it, swap — overlap, never a gap. The same manager pattern as a
connection swap.

> **A cheap producer does not just make ingestion free. It makes ontology change affordable** —
> which is the precondition for a learned basis, because you cannot evolve a basis you cannot afford
> to re-derive.

Candidates are proposed freely, scored, and deliberately **not** part of the space. What policy
promotes them is unwritten on purpose: it needs a corpus that does not exist, and a promotion rule
with no data behind it is roadmap pretending to be code.

## 11. What the lab measured · `BUILT`

Runs live in [`lab/`](./lab), results in [`lab/results/`](./lab/results). Seeded, committed, and
`summary.md` is generated from the JSON so it cannot drift from what ran.

This is a reference for the claims above, not a history. When a finding changes, the claim changes
with it and the old one goes.

| | finding | run |
|---|---|---|
| 1 | **Richness beats parsimony.** More axes buy separation faster than distractors erode it. | `e1`, `e2b` |
| 2 | **Scale is not the enemy.** `recall@1` *rises* with corpus size. | `e1` |
| 3 | **Redundancy is invisible to ranking, corrosive to thresholds.** | `e2`, `e2b` |
| 4 | **Concentration is stable in N** and does not track recall. | `e1` |
| 5 | **Ranking must be axis-major.** 184ms → 45ms at 50k × 144 axes. | `e1` |
| 6 | **Partial coverage breaks retrieval, and the SHAPE matters more than the amount.** | `e4` |
| 7 | **The scale walls were engineering, not design.** 250k records: 2.8s load, 72MB, 254ms unnarrowed `near()`. | bench |

**1 · Richness.** At 50k records, `recall@1` = 0.750 / 0.800 / 0.888 for 24 / 72 / 144 axes — each
config carrying 20% distractors. Sweeping *discriminating* axes at 8k records: 0.41 / 0.76 / 0.87 /
1.00 for 3 / 6 / 12 / 40. Many axes form an error-correcting code over assessment noise.

**2 · Scale.** At 144 axes, `recall@1` rises 0.825 → 0.888 from 1k to 50k records. More records means
more confusers, but also a *denser* sampling of each concept — so the nearest same-region neighbour
closes faster than the nearest wrong-region one. Density wins, at least to 50k.

**3 · Redundancy.** Adding up to 24 duplicated noise axes changed `recall@1` by less than the
standard error, at every signal level, in one domain and in four. The same-vs-other **margin** fell
20–46%. Ranking is invariant under anything monotone; an absolute threshold is not. This is why a
radius is fitted (§6) and why `stats.correlations()` is a **region-health** instrument rather than a
retrieval one.

**4 · Concentration.** `(mean − min) / mean` over a random slice of the corpus is flat in N (0.373 →
0.385 at 24 axes; 0.248 → 0.259 at 144). It falls from two domains to six and then plateaus — cross-
domain averaging reducing spread — and it does not predict recall. **A weaker instrument than
expected; margin is the one that matters.**

**5 · Performance.** 50k records × 144 axes cost ~184ms per `near()`, against ~7.2M component
comparisons of actual arithmetic. The planner was rebuilding a `Coord` per candidate — two
`Float32Array`s and a full copy each — which is **row-oriented work over a columnar store**.

Two attempts, and the failed one is the more instructive. Parameterising the metric over an accessor
object to avoid the allocation made it *worse*: **272ms**, because four megamorphic closure calls per
axis per candidate defeat inlining and cost more than the garbage they removed. Inverting the loop
fixed it — axes outside, candidates inside, so each column is walked once contiguously for every
candidate at once: **45ms, 4.1x**, with exact equivalence to the reference.

Two lessons worth keeping. **An abstraction introduced to avoid duplicating a metric can cost more
than the duplication** — `store/rank.ts` is now the metric a second time, bound to the reference by
an equivalence test rather than by a shared implementation. And the remaining cost is no longer the
metric: it is 50k `{ slot, distance }` objects allocated and sorted per query, which a bounded top-k
would remove.

**6 · Coverage.** The worst result so far, and it lands on the design's own intended shape — a
mechanical producer filling one domain and a model filling another means **partial coverage is the
normal state of a real store.**

With a fully measured probe against a partially measured corpus, `recall@1` falls from 0.855 to
**0.165** as random coverage drops to 25%. Margin barely moves (0.083 → 0.069), so this is a
different mechanism from finding 3 — recall collapses while thresholds hold, the exact inverse.

The shape matters more than the amount. At the same ~12-axis budget:

| | axes compared | recall@1 |
|---|---|---|
| random 25% — scattered across four domains | 12.2 | **0.165** |
| domain 25% — one whole domain | 16.4 | **0.390** |

Two mechanisms, and neither is "less information":

1. **The square root sits inside the per-domain average.** The combined distance is
   `mean_domains( sqrt( mean_axes(δ²) ) )`, not `sqrt( mean_all(δ²) )`. Scattered coverage leaves
   three axes per domain, so each inner `sqrt` is taken over a three-sample mean and its noise does
   not cancel when the domains are averaged.
2. **Selection bias.** With 8k candidates whose true distances span a band only 0.083 wide, ranking
   by a point estimate whose noise is comparable to that band means **the winner is whoever got
   lucky.** Thin estimates win rankings they have not earned. Domain mode is non-monotonic for this
   reason — worst at 75% coverage, where records *differ* in how much was measured, and recovering at
   25% where they are uniformly thin.

### The fix was architectural, not mathematical

Separating *uniform* thinness from *mixed* coverage is what resolved it. Mixed is the real producer
scenario — half the records assessed by every producer, half by one — and it is the case a floor
exists for:

| arm | cov 100% | 75% | 50% | 35% | 25% |
|---|---|---|---|---|---|
| **uniform** — every record equally thin | 0.825 | 0.740 | 0.575 | 0.365 | 0.175 |
| **mixed** — half thick, half thin | 0.825 | 0.790 | 0.570 | 0.355 | 0.215 |
| **mixed + `minCompleteness: 0.8`** | 0.825 | **0.830** | **0.830** | **0.830** | **0.830** |
| **domain** — whole domains present or absent | 0.825 | 0.430 | 0.380 | 0.375 | 0.370 |

`minCompleteness` is a **filter**, not a change to the metric: refuse to rank a candidate measured on
less than a given fraction of what the probe measured. On the mixed case it is decisive and **flat** —
0.215 → 0.830 at 25% coverage, holding at baseline across every level, because it ranks the thick
half and *refuses* the thin half rather than mis-ranking it.

Three properties worth knowing:

- **It cannot help uniform thinness.** With every record equally thin, a floor either keeps everyone
  or nobody — `uniform + floor` returns *nothing* below 50% coverage. That is the honest failure ("I
  have nothing I can confirm") rather than a confident wrong answer, but it is a refusal, not a
  recovery. Uniform thinness is a genuine information limit.
- **Whole-domain coverage is roughly twice as good as scattered** at low coverage (0.370 vs 0.175),
  confirming mechanism 1 from the other direction. One producer per domain is a structural fix that
  needs no code.
- **Completeness weighting** (a domain compared on 3 of 12 axes carries a quarter of its weight;
  identity at full coverage) is in, and is principled but minor — 0.500 → 0.555 at half coverage.

So the two metric changes are **not needed** and stay unbuilt. For the record, they were: pooling in
squared space (one `sqrt` at the end, attacking mechanism 1, but cosine is not a squared distance) and
pessimistic ranking (`distance + λ/√compared`, attacking mechanism 2, but λ has no principled value).

### Three defences, in order of strength

1. **Keep coverage uniform.** Backfill a new axis before relying on it. Prevention, free.
2. **One producer per domain**, and scope queries to domains. Structural, ~2x at low coverage, no
   code change.
3. **`minCompleteness`** when mixed coverage is unavoidable. Enforcement, decisive on the case it is
   for.

And two instruments so the state is never invisible: `plan.coverage` reports the min/max/mean
completeness of everything it ranked — a wide spread is the signature of an untrustworthy ranking —
and `stats.coverage()` reports per-domain `complete` / `absent` / **`partial`** fractions across the
store. Complete-or-absent is safe; **partial is the dangerous middle.**

**7 · Scale, after the three fixes.** Batched writes, 8-bit columns, and leader clustering, measured
end to end:

| | 50k × 144 axes | 250k × 144 axes |
|---|---|---|
| load | 0.5s *(was 4.6s)* | 2.8s |
| columns resident | 14MB *(was ~58MB)* | 72MB |
| unnarrowed `near()` | 43ms | **254ms** |

Extrapolating the columns: a million rows at 200 axes is ~400MB, which fits. Extrapolating `near()`:
a million is ~1s and ten million ~10s **if nothing narrows first** — so the linear scan is the one
remaining wall, and the answer is the same as everywhere else in this package. *Never rank the whole
store.* Pair `near()` with a `where` or a `when`. The genuinely global "find anything like this" query
is the only case that would need a coarse per-axis bucket index, and it is unbuilt.

**And the consolidation bench failed usefully.** Both radii found 500 leaders, hit the cap, and merged
almost nothing (250,000 → 249,871). Two lessons:

- **The corpus is the wrong shape for it.** This generator is built to be *hard for retrieval* —
  `overlap: 1.0` means members spread as wide as the gaps between concepts, so nothing is tightly
  duplicated. Consolidation operates on near-duplicates: the same situation observed fifty times.
  **E3 needs its own generator**, and that is the real prerequisite rather than the algorithm.
- **The guard earned itself immediately.** The first attempt at this bench used `radius: 0.08` against
  a mean distance of ~0.35, so nothing clustered, every row became its own leader, and it ran for
  minutes on the quadratic path before being killed. With `maxLeaders` it returns in 0.3s and reports
  `truncated: true`. A silent quadratic blowup became a bounded answer that says it is partial.

### What the lab cannot answer

The generator plants structure and recovers it, so it validates the **store and the metric**. It says
nothing about whether human-named axes capture real structure — that is the ontology question, and
only a real corpus answers it. Two rounds of this bench produced meaningless numbers before the
generator was adversarial enough to be informative: a ceiling at `recall@1 = 1.000` everywhere, then
a null result caused by sweeping the wrong variable. **The generator is the experiment.**

---
---

# Part II — The thesis

Part I describes something implemented and checkable. **This part is a bet**, and the sections are
marked with the evidence they actually have.

## 12. Where axes come from · `DESIGNED`

The algebra is ~700 lines and it is done. Everything hard is upstream of it: **who assigns the
coordinate.**

Geometry over noisy coordinates is noise. Ask a model for `threat` twice and get 0.7 then 0.85;
cosine over that measures the sampler. The rule that falls out:

> **The primitive's value is inversely proportional to the distance between the axis producer and
> physics.**

| producer | how | cost | stability |
|---|---|---|---|
| `Mechanical` | computed from typed fields — L0 facets, lint exit codes, entity stats | free | exact |
| `Table` | a static build-time table, keyed by entity type | free at runtime | exact |
| `Probe` | one frozen-encoder forward pass + N linear heads | ~free | deterministic |
| `Model` | render to text, ask the axis questions in one batched call | cheap | **unmeasured** |

Note what the archive's history says: four trained ONNX classifiers per domain rather than model
tagging, plus three entropy diagnostics whose only purpose was detecting axes that fire on
everything. That is the fingerprint of someone who hit the stability wall and built instruments
for it.

### The producer boundary

`Locus.put()` takes a coordinate. It never makes one. So the one thing needing an API key and a
`fetch` cannot leak into the storage layer, and a producer can be swapped — static table today, live
model tomorrow — with nothing downstream knowing.

Several producers compose, each owning disjoint axes. The realistic case for an entity: `size`,
`speed`, `damage-rate` mechanical from a world API; `is-building-block`, `makes-noise` from a model.
One coordinate, two producers, one merge, and **one axis one producer** enforced — two disagreeing
sources is a drift no query could surface.

### The cheapest viable producer is smaller than it looks

A frozen embedding model plus one logistic regression per axis. One forward pass shared across every
axis, then N dot products. Adding an axis means training one probe on a few hundred examples —
minutes, no GPU. That directly dissolves *hand-defined therefore small*: axes become cheap to add
and cheap to retire.

### The gate · `OPEN`

Calibration is not reproducibility. Calibration is a property of a distribution across many items;
it says nothing about whether the same input twice returns the same number. Geometry needs the
second.

> **The test, unrun:** 30 items × 20 questions × 5 repeats. Measure per-axis variance, and whether
> **nearest-neighbour ranking** survives re-query. Ranking stability is the requirement, not value
> stability.

The outcome branches cleanly, which is why it goes first:

- **stable** → the model is the producer, cached per item.
- **not stable** → the model is a **label factory** for a distilled local probe. Which is the
  original plan, except labelling just got two orders of magnitude cheaper, so distillation becomes
  cheap rather than inference becoming free.

Either branch works. The point is knowing which one you are in before designing on top.

### The version that is actually free

For a closed world with a known entity table, classify **once per entity type, at build time**, and
ship a static axis table. Zero runtime cost, fully deterministic, no network in the perception path,
no vendor in the loop. Every query property is identical.

That is the right first build: it proves the query power at zero architectural risk. The live path is
what you graduate to when the closed-world assumption breaks — and the architecture is the same
either way, because a producer sits behind one interface.

---

## 13. The bitter-lesson fork · `OPEN`

State your own weakest point before anyone else does.

Sutton's *Bitter Lesson* (2019) has seventy years behind it: methods that leverage computation beat
methods that leverage human insight. Hand-engineered features lost in vision, speech, NLP and games.
The answer is not "he's wrong."

Read it precisely. The lesson is about hand-engineering **the content of knowledge** — features,
rules, ontologies. It is not about having no architecture. Transformers are architecture. Tokenisers
are architecture. **AlphaZero ran explicit hand-designed MCTS** and that search was essential;
nobody thinks AlphaZero refutes the bitter lesson.

Which gives the fork, and it is sharp:

```
hand-authored axis table         = hand-authored knowledge  = Cyc  = forty years, no general inference
discovered axes, named readouts  = a learned representation you can read
```

**This project's survival depends on being on the second line.** Every other claim in this document
survives either way. That one does not.

### The escape: axes validated by dynamics

The habit-graph idea this all started from — nodes are situations, edges are actions — is a Markov
Decision Process. The realisation *"nodes must be rich enough to identify the situation"* is the
**state abstraction** problem, and it has a formal criterion:

> **Two situations should share a node iff they behave the same under every action.**

That is **bisimulation** (Ferns, Panangaden & Precup, 2004), with a metric form and a deep-learning
version (Zhang et al., 2021) that learns latent spaces where distance *is* behavioural distance.

The consequence is the important part:

> **Dynamics validate the axis space. Automatically. With no labels.** Two situations on the same
> coordinate that behave differently mean **an axis is missing** — detectable from prediction error.
> An axis that does not reduce prediction error is dead weight and can be pruned.

So the general axis space is not authored. It is **discovered by whether it makes the world
predictable.** A model proposes candidates cheaply; the dynamics prune them. Hand-authoring is a
bootstrap seed, never the design.

**The drift test:** if an axis is being added because it *describes the domain* rather than because a
consumer reads it and prediction error drops, the ontology has crossed onto the first line.

### The strongest counter-argument, stated fairly

Perhaps nobody revived Cyc and SOAR because once you have a model good enough to ground symbols,
that model can just do the task, and the symbolic layer is redundant.

The answer is the semantic-compilation argument (§14) — models are expensive, non-deterministic and
un-inspectable, so a cheap deterministic readable layer earns its place even where a model *could*
substitute. That is probably right. It is a bet on cost and reliability curves, not a proof.

### Why the symbolic attempts actually failed

Not because symbolic structure is wrong. They failed on the **symbol grounding problem** (Harnad,
1990): symbols had to be hand-fed, because nothing could turn perception into symbols. SOAR could
reason beautifully about blocks it was *told* about; it could not look at a table.

That was insurmountable in 1985. A VLM plus a calibrated classifier is a symbol acquisition pipeline
that did not exist two years ago. **The specific bottleneck that killed them has dissolved** — which
is a different situation from standing on a pile of bones.

---

## 14. Semantic compilation · `BET`

The framing that makes the economics work.

```
BEFORE the boundary   expensive, model-bound, once per item
AFTER  the boundary   float arithmetic. thousands of operations per second, deterministic.
```

Compare, store, recall, consolidate, check a goal, detect novelty, measure a trajectory: all free
once a coordinate exists. That is an **amortisation boundary**, and it tells you where to put it —
as early as possible, exactly once per item, because everything downstream is free and everything
upstream is not.

It also explains why the cache key matters: keyed on a description, the description must be a
**stable committed artifact**, or it drifts per tick and you pay per tick. Which is what a
discretising layer is supposed to produce anyway. Cost model and architecture agreeing is a good
sign.

---

## 15. Placement in an architecture · `BET`

For a three-layer cognitive stack — `L0` unnamed tracked things, `L1` named kinds, `L2` plans over
time.

### The coordinate is born at L1, not L0

L0's output is already a good IR: typed, dimensioned, precise components. Converting those to 0–1
memberships **discards precision**, which is definitionally the L0→L1 seam. A coordinate is what you
get on the far side of a discretisation, not before it.

Nor is it an L1 *belief*. L1 commits discrete names; a coordinate is a bag of floats. The resolution:
**the coordinate is the key you recall on; the name is the belief.** Distance generates the threshold
crossing; the float never enters the component vocabulary.

Which makes Locus a **service** the way geometry helpers are services — not a module in the layer
stack.

### One type, both directions

```
ascending     facets → coordinate → nearest region → kind
descending    goal   → coordinate → error vector   → bid bias
```

That is what makes it an intermediate representation rather than a store, and it is *why* a goal can
be compared to a situation at all. Bidirectional IRs are rare, and they are what makes a seam cheap.

### It gives the descending channel a type

"L2 emits goals, priors and weights that L1 arbitrates under" currently has **no type**. A property
map over named axes *is* a weight vector, and `shift(current, difference(goal, current), 0.5)` is
literally biasing.

So the L2→L1 seam becomes a **schema instead of a prompt**, and a model structurally cannot emit
something the layer below cannot act on. Given an invariant that L2 biases but never actuates, this
is the enforcement rather than the discipline.

Without it, that seam accretes a switch statement per goal kind — the thing a variant table exists
to prevent.

### The control half is already a proven discipline

`if (mad > 0.8) shutdown()` and "run home if scared or hungry" are **fuzzy control**, the most
commercially successful symbolic-adjacent AI ever deployed: Mamdani and Sugeno controllers, subway
braking, camera autofocus, ABS. `scared OR hungry` is `max(scared, hungry)`. A priority table with
reserved bands is a defuzzification strategy.

Two things are new: the producer can be a language model, so the domain becomes **semantic** rather
than thermodynamic; and the same representation doubles as **memory**, which fuzzy control never had.

And the known failure mode of classical fuzzy control is **rule explosion** — `M^N` potential rules,
unmaintainable in the low dozens. Comparing to a **goal region** is one distance computation instead
of an enumerated rule set, which routes around it.

---

## 16. Behaviour and imagination · `BET`

### A coordinate space cannot simulate

It encodes state and has no dynamics. You can move a point, but nothing says where it should go. The
fix is not more axes — it is one more object:

```ts
type Transition = (from: Coord, action: Action) => Coord
```

Roll it forward and that **is** imagination. Encode the teapot, apply `hit-with-hammer`, read the
result. Which is a **latent dynamics rollout** — model-based RL (Ha & Schmidhuber's *World Models*,
then PlaNet/Dreamer: encode to latent, learn dynamics there, roll forward to plan).

Two things make a manifest version unusual:

- the triples `(before, action, after)` are generated for free by any ticking agent.
- **a learned transition is readable.** `hit-with-hammer` comes out as
  `Δ{ intact: −0.7, fragmented: +0.6 }`. You can inspect the physics the system learned and tell
  whether it is wrong. Latent dynamics models are normally completely opaque.

### Behaviour is the consolidation ladder, applied to sequences

```
episode     one observed trajectory                     specific, raw, cheap
pattern     centroid of aligned trajectories + count    a behaviour, with confidence
operator    a learned Δ over the space                  generalises to unseen inputs
```

Left to right is the same radius clustering as memory consolidation. **Behaviour learning and memory
consolidation are one mechanism** — now operating on sequences instead of points.

```ts
type Behaviour = {
    precondition: Region     // ← the same Region. sixth job.
    sequence: Coord[]
    count: number
}
```

### Prediction without identity

The payoff, and it is better than asking for it: **the kind is never needed.** Prediction requires
only that a coordinate land in a precondition region. A brand-new entity that happens to be
gelatinous and slow inherits slime predictions **without ever being labelled a slime.**
Generalisation by similarity, free, no classifier, no name.

If a region claims it you get a name *and* predictions. If none does you get novelty and open one.
Same call, same threshold, and an unrecognised thing still gets predictions from whatever is nearest.

### Two limits

**Property-level, not geometric.** "The teapot shatters" — yes. "Into these six fragments with these
trajectories" — no, that needs a spatial representation. Which is correct: geometry belongs to the
sensing layer, property-level prediction to the layers above.

**Rollout error compounds.** Uniform across the model-based RL literature: the useful horizon is
5–15 steps before predictions are noise. Imagination is **tactical** — choosing between immediate
alternatives, not planning an afternoon. Plan for a short horizon rather than discovering it at step
forty.

### The teapot example contains the relation bug

```
teapot intact  →  teapot cracked, hammer touching  →  teapot smashed, hammer gone
```

"Hammer touching" is not a property of the teapot — it is a **relation**. The fox-and-wall problem
arriving inside the transition model. So:

```ts
transition(coord, action, context)       // hit(target, with: hammer)
```

**The action carries the binding; the coordinate carries the state.** Transitions over coordinates
work for intrinsic change (intact → cracked, fresh → rotten) and break for relational configurations
(who is touching what, what is inside what).

### Imagination: keep the loop, drop the pixels

Feeding predictions through the same path as perception is well-founded — the comparator model from
predictive processing, and mental imagery genuinely reactivates early visual cortex. "How does it
know it isn't real" has a real answer too: **reality monitoring**, a source tag plus weaker
input-driven drive. Failures of exactly that mechanism are hallucination.

But *rendering* a prediction to an image and re-perceiving it is a lossy identity function with two
model calls inside it. The symbolic prediction is already in hand; pixels can only lose information.

> **Inject the prediction where it is consumed, not at the sensor.** Same *components*, not same
> *modality*.

Which is also the better reading of the neuroscience: imagery drives the same *representation*
top-down, it does not synthesise retinal input.

Two consequences:

- **`source: "sensed" | "imagined"` is an invariant, not a feature.** Imagined coordinates writing to
  the same components as sensed ones, unmarked, *is* hallucination — structurally, not
  metaphorically. Make it unrepresentable rather than unlikely.
- **The full render loop is a good test.** Render a predicted scene, run real perception on it,
  assert you recover what you predicted. That closes the loop between the symbolizer and the
  predictor. Diagnostic, not runtime.

---

## 17. On unification · `BET`

The intuition that imagination composes seamlessly, so there must be one shared representation, has
a hole worth naming: **seamlessness of experience is weak evidence for unity of format.**
Introspection reports the output of integration, not the encoding. Aphantasia (no voluntary imagery,
intact conceptual reasoning), double dissociations across modalities, and radically different codes
by region (retinotopic, tonotopic, population vectors, place and grid cells) all argue against one
universal format. The mainstream view is many specialised representations plus a convergence
mechanism.

But the deeper instinct is vindicated from an unexpected direction: **grid-like codes organise
non-spatial conceptual knowledge in humans** (Constantinescu, O'Reilly & Behrens, *Science* 2016),
reviewed with Gärdenfors as a co-author (Bellmund et al., *Science* 2018). The brain reuses
metric-space machinery for concepts. Coordinate spaces are a real primitive in there — just not the
only one.

**The engineering conclusion matters more than the neuroscience: do not chase completeness.** An IR
that must represent everything becomes either a graph or a logic, and inherits the maintenance
problems this exists to escape. A small number of specialised representations with clean seams beats
one universal one.

### What unification actually looks like

Not one format. One **composition pattern** over several:

```
coord        Coord                     position — the only thing the metric reads
quantities   { value, unit }           dimensioned measures
when         TimeRange                 a filter and a sort key
payload      Pointer                   content
relations    Edge[]                    to other records
dynamics     BehaviourRef[]            what it does
source       "sensed" | "imagined"     provenance
```

An ECS entity. No schema; every component optional; each query engine reads only what it needs.
Adding a new *kind* of knowledge is a new component, not a migration — which is the actual answer to
"store any concept without predefining the structure."

**The unity is in how things compose, not in what they are.**

---

## 18. Open problems · `OPEN`

| | |
|---|---|
| **axis stability** | the gate. Unrun. Everything in Part II waits on it. |
| **promotion policy** | how a candidate earns adoption. Needs a corpus that does not exist. |
| **domain weights** | the entire quality of the metric, with no principled way to set them a priori. Needs an eval: "these N pairs should be nearer than these M pairs." Gärdenfors' own criterion puts salience weights **inside the concept** rather than in the space, which suggests they belong on `Region` rather than on `Domain` — unbuilt. |
| **convexity** | is a concept one region? Multi-prototype mitigates; nothing verifies. |
| ~~**scale**~~ | **answered for synthetic corpora** — `recall@1` rises with N to 50k (§11). Still open on a *real* corpus, where the ontology rather than the metric is the variable. |
| **the consolidation curve** | compression against region-level retention. The first legible number in this space. Now measurable: the radius is fitted, and the algorithm is `O(records x leaders)` rather than quadratic. |
| **recall beyond 50k** | `recall@1` *rose* with N to 50k because density improved faster than confusers accumulated. That reasoning expires — density saturates, confusers do not, and the argmin-over-noisy-estimates problem worsens with more candidates. **We measured the rising half of a curve that probably turns over.** Cheap to find. |
| **migration cost at scale** | re-assessing a million records is a million producer calls. Affordable in money; the wall-clock and orchestration are untested, and §10 claims ontology change is affordable with no number behind it. |
| ~~**coverage**~~ | **measured and addressed architecturally.** `recall@1` fell 0.825 → 0.175 under thinning coverage; a `minCompleteness` filter restores 0.830 flat on the mixed case that real producers create. Residual: *uniform* thinness is a real information limit a filter cannot recover, and the two metric changes stay unbuilt. §11. |
| **query-level axis health** | the failure mode is per-QUERY, not per-space: a query scoped to a domain where two axes discriminate and one is triplicated is fragile while every other query on the same space is fine. `explain()` already has the per-domain contributions; it could report how much each domain actually varied across the ranked set. |
| **relations** | an edge table is designed and unbuilt. Needed the moment crafting or containment appears. |
| **calendar predicates** | `when` takes ranges; day-of-week and hour-of-day are applied by the caller. The concrete argument for the chronology leaf. |
| **rollout horizon** | assume 5–15 steps; measure it rather than assuming better. |

### And one process note

The archive's failure was that agents did not reliably write their memories. That was a harness
limitation — the bottom-up path (subsystems recalling and writing without a model deciding) was
available and unbuilt. But the design preference it suggests stands:

> Encoding should be **involuntary**. In a text agent, writing is a deliberate tool call competing
> with the task, and it loses. In an embodied one, a tick writes a coordinate whether anything asked
> or not.

Which is a third reason the embodied setting suits this: stable axes, physics-adjacent producers, and
an involuntary write path.

---
---

# Part III — Record

## 19. Tried and rejected

The section nobody writes. Each of these was reached for and abandoned for a reason worth keeping.

| rejected | why |
|---|---|
| `symbol(string)` returning a method-bearing object | fused three things — the payload, the coordinate, the producer. Baked in "payload is a string" and "a symbol tags itself". A coordinate is **data**, not an object: no methods, no `tag()`, no mutation. |
| mutable `tag()` returning the same symbol | a coordinate is a point and points do not move. Progressive tagging is a text-pipeline affordance; a recorded position must be frozen or stored history is not history. |
| sparse `Record<string, number>` | conflates *absent* with *zero*. `contact: 0` and `contact: never-measured` are different facts and only the second is worth noticing. Dense over a fixed basis makes the ambiguity unrepresentable — and makes it a real vector at the same time. |
| `intersect` as an average | not a t-norm; `avg(0.8, 0) = 0.4`. Renamed `commonality` (correct as a restricted centroid) and the missing `match()` added. |
| cosine as the global metric | discards magnitude, so `wary` and `terrified` compare as identical when the ratios match. Catastrophic for any threat judgement. Metric is now per domain. |
| `similarity` returning `0` on no shared keys | indistinguishable from "measured, and maximally dissimilar". Throws now; `explain()` is how you ask. |
| a raw Unix timestamp as an axis | dimensioned, unbounded, ~1.7×10⁹ beside values ≤ 1 — under any metric the timestamp *is* the entire similarity. Time is a filter and a sort key. |
| axes as a calculator | axes are coordinates, not variables. A vector space has no product of two components. Computation goes in the payload. |
| quaternions / complex axes | they add a structure-preserving multiplication (rotation), not capacity. Membership has no phase. The legitimate uses are narrow: **cyclic** quantities want a sin/cos pair, and **binding** wants phase — and binding is a separate mechanism. |
| a vector store (pgvector, HNSW) | built for approximate NN over opaque high-dim vectors. This needs exact per-axis predicates over 60–200 named dims at a scale where scanning is already free. |
| a bespoke `LocusError` | the repo has a mature error package whose `err()` emits to the trace sink. A parallel class would have been a tracing gap in the subsystem that needs tracing most. |
| `remote` as a third persistence | a remote client has no local engine at all. Modelling all three as one substrate forces the remote to pretend it owns columns, or forces the engine into an RPC shape. It swaps the whole handle instead. |
| free axis proposal with migrate-to-nearest | a continuously drifting basis cannot accumulate comparable history. Split into continuous weight decay and discrete versioned re-assessment. |
| a `Coord` as `shift`'s direction | a position is bounded to `[0,1]`; a direction is signed. One type would either permit negative membership or make "move away" unrepresentable. Direction is `Gap[]` — which makes `difference` and `shift` compose. |
| a hand-chosen `Region.radius` | an absolute threshold cannot know the axis table, the domain weights or the metric. Lab `e2b` measured margin falling 20-46% with ranking unmoved, so a fixed radius silently over-claims as the space grows and novelty degrades with no symptom. Fitted from members now. |
| `concentration` as the primary health metric | a normalised shape measure. It is stable in N and does not track recall — it could not see the one real effect in `e2b`. **Margin** is the instrument. |
| rendering imagination to pixels and re-perceiving | a lossy identity function with two model calls inside it. Inject at the consumer. Keep the render loop as a *test*. |
| defining enough axes to represent physics | the road to Cyc. Axes are chosen by the **decisions they serve**, never by the domain they describe. |

## 20. Found by the tests, not the design

Recorded because the ratio matters: four real defects in the first green run, none visible from
reading the design.

1. **`shift` taking a `Coord`** — a direction is signed. Caught by a clamp test that could not
   construct its own input.
2. **Predicate boundaries silently wrong** — columns are `Float32`, thresholds arrive as `Float64`,
   so `0.8` as written is strictly less than `0.8` as stored and `lte: 0.8` excluded a row holding
   exactly `0.8`. Fixed by rounding thresholds into the stored precision rather than an epsilon.
3. **Nothing validated the unit cube** — a fixture wrote `1.03` and the store accepted it, averaged
   it into a prototype and reported a plausible distance. Readings are now range-checked at the one
   door into the space.
4. **`explain` used exceptions as planner control flow** — it now reports `compared: 0` with `NaN`,
   and `distance()` throws.

## 21. References

Annotated by what each is *for*.

**The representation**
- Zadeh, "Fuzzy Sets" (1965) — graded membership. t-norms are the closed family of valid ANDs; the
  boundary condition is what rules out an average.
- [Gärdenfors](https://watermark02.silverchair.com/9780262273558_google_scholar_preview.pdf?token=AQECAHi208BE49Ooan9kkhW_Ercy7Dm3ZL_9Cf3qfKAc485ysgAAAk8wggJLBgkqhkiG9w0BBwagggI8MIICOAIBADCCAjEGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMKzDMf2EFYjxhtJ7OAgEQgIICAuCJkDRqIUUUlCk3eMwPStqgVAd25KmRV4egvCbz16cvqJTOEt_b7WjU2f1DYXz0f7XGXJzy52M9mcFdKKeqrL6uZjOM7YfbyIpWYtJ_40O604M40xQT8isRVkgrKjF-meIpoTiwrJ5mfyjamiFaH9Pdt-f38Yiw_KqViqrXefD2hGaMB6K3cXYX3E5Xe6naNpg8diOmT2EtOWfrdJCVM_0HPzmm4pOy9edqmviun6wvOXVdJaY4K1lT7pWjsz62X75_a30ivwrgC7Ty_P7ONMDW0SQYFUbLAOieUaR9n_b90-Il_KVMP584YRusVlQJTxP0hCirnPunW7dtkH7Z7Wkhf9H6vsmyIvmSNhZvp_vTwXQDO-vQBjEJ6efCYTIhp8Gq816IrqZh_A4twlHCSbPWLav9QpPjh-YrtFNcCA0sVaqRce_rFled-52ItKNGQBD3FIGPaGqvyuM5vP7GmaoTGiyMhT2wKJKwPuQpLTOFgliEIgSyOubDrHmKDNx6woJlZqJ3u6tf3s1ioOICGvDdvyHF1768RyqxDSL8JTVIUbUpuZMaHU1y3goobS5DQiWF8phg0ZLHy-kv4-_ZI1HsWQHHdKnmiGS8uqmEsz-HewYtVdiXNQJMIwFuwlAgTyJdnHUvDjZJUSu6oLOYu8oHQtHDr-l1gNq433ZzpdQmMf0), *Conceptual Spaces: The Geometry of Thought* (MIT Press, 2000) — the direct ancestor.
  Quality dimensions, domains, concepts as convex regions, prototypes as centroids.
- Osgood, *The Measurement of Meaning* (1957) — named-axis rating plus geometry, and evidence that
  it recovers structure that replicates across cultures.
- Kanerva, *Sparse Distributed Memory* (1988) — the same addressing-by-content idea with meaningless
  dimensions. The useful contrast.
- Plate, *Holographic Reduced Representations* — where role binding lives, and the interpretability
  it costs.

- Shepard, "Toward a universal law of generalization for psychological science" (*Science*, 1987) —
  similarity decays exponentially with distance. What `generalisation()` implements.
- Tulving & Thomson, "Encoding specificity and retrieval processes in episodic memory" (1973) — more
  encoded attributes means more retrieval cues. The mechanism behind finding 1 in §11.

**Evidence that named attribute spaces work**
- Lampert et al., "Learning to detect unseen object classes by between-class attribute transfer"
  (2009) — ~85 named attributes supporting classes never trained on. The closest thing to a
  demonstration of the entity plan.
- Constantinescu, O'Reilly & Behrens, "Organizing conceptual knowledge in humans with a gridlike
  code" (*Science*, 2016) — grid codes over non-spatial concepts.
- Bellmund, Gärdenfors, Moser & Doeller, "Navigating cognition" (*Science*, 2018) — the review where
  conceptual spaces and grid cells meet.

**The criterion for a good basis**
- Ferns, Panangaden & Precup, "Metrics for finite Markov decision processes" (2004) — bisimulation
  metrics: two states are equivalent iff they behave the same. **The answer to "is my axis set rich
  enough."**
- Zhang et al., "Learning invariant representations for RL without reconstruction" (2021) — the deep
  version: latent spaces where distance *is* behavioural distance.

**Dynamics and imagination**
- Ha & Schmidhuber, "World Models" (2018); Hafner et al., PlaNet / Dreamer — encode to a latent,
  learn dynamics there, roll forward to plan. What a transition operator looks like in practice.
- Daw, Niv & Dayan on model-free vs model-based control — habits and imagination as the two known
  arms, and uncertainty-based arbitration between them.

**The arguments against**
- Sutton, "The Bitter Lesson" (2019) — must be answered, not dismissed. §12.
- Harnad, "The Symbol Grounding Problem" (1990) — why the symbolic architectures stalled, and what
  changed.
- Cyc — forty years, millions of hand-authored assertions, no general inference. The most expensive
  negative result in the field, and it is directly about axis proliferation.

**Architecture, for company**
- LeCun, "A Path Towards Autonomous Machine Intelligence" (2022) — a cognitive architecture proposal
  from a Turing laureate: world model, actor, cost module, configurator.
- Brooks, subsumption architecture (1986) — reflexes outranking plans without an override mechanism.
- Marr, *Vision* (1982) — the three levels. The standard defence of doing architecture work at all:
  a system cannot be understood from its implementation alone.

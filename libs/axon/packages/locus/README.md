# locus

**Memory as geometry.** Records stored at a coordinate in a *manifest* conceptual space —
queried by exact predicate, ranked by distance, and consolidated by arithmetic.

```ts
const space = Space({ axes: AXES })
const locus = await Locus({ space: space, conn: { type: "sqlite", path: "./memory.db" } })

await locus.records.put({ coord: await assess(entity), payload: entity })

await locus.records.putMany(batch)   // one transaction — the only way a large store loads

// narrow — exact, no metric, no model
await locus.records.query({ where: { "audio:emits": { gt: 0.6 }, "use:interactive": { gt: 0.5 } } })

// rank — the one metric, scoped to a domain
await locus.records.near(probe, { domain: "form", limit: 10 })

// recognise, or discover that nothing is like this
locus.regions.claims(probe)   // [] is the novelty signal
```

---

## What it is

An axis is a named, graded property. A **coordinate** is the degree to which one thing holds
every axis in the space. Formally: each axis is a fuzzy set, and a coordinate is a point in the
unit hypercube `[0,1]^N` of their product — [Gärdenfors' conceptual spaces](https://watermark02.silverchair.com/9780262273558_google_scholar_preview.pdf?token=AQECAHi208BE49Ooan9kkhW_Ercy7Dm3ZL_9Cf3qfKAc485ysgAAAk8wggJLBgkqhkiG9w0BBwagggI8MIICOAIBADCCAjEGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMKzDMf2EFYjxhtJ7OAgEQgIICAuCJkDRqIUUUlCk3eMwPStqgVAd25KmRV4egvCbz16cvqJTOEt_b7WjU2f1DYXz0f7XGXJzy52M9mcFdKKeqrL6uZjOM7YfbyIpWYtJ_40O604M40xQT8isRVkgrKjF-meIpoTiwrJ5mfyjamiFaH9Pdt-f38Yiw_KqViqrXefD2hGaMB6K3cXYX3E5Xe6naNpg8diOmT2EtOWfrdJCVM_0HPzmm4pOy9edqmviun6wvOXVdJaY4K1lT7pWjsz62X75_a30ivwrgC7Ty_P7ONMDW0SQYFUbLAOieUaR9n_b90-Il_KVMP584YRusVlQJTxP0hCirnPunW7dtkH7Z7Wkhf9H6vsmyIvmSNhZvp_vTwXQDO-vQBjEJ6efCYTIhp8Gq816IrqZh_A4twlHCSbPWLav9QpPjh-YrtFNcCA0sVaqRce_rFled-52ItKNGQBD3FIGPaGqvyuM5vP7GmaoTGiyMhT2wKJKwPuQpLTOFgliEIgSyOubDrHmKDNx6woJlZqJ3u6tf3s1ioOICGvDdvyHF1768RyqxDSL8JTVIUbUpuZMaHU1y3goobS5DQiWF8phg0ZLHy-kv4-_ZI1HsWQHHdKnmiGS8uqmEsz-HewYtVdiXNQJMIwFuwlAgTyJdnHUvDjZJUSu6oLOYu8oHQtHDr-l1gNq433ZzpdQmMf0)
with a store attached.

The one word that matters:

| | dimensions | |
|---|---|---|
| **latent** space | emerge from training, uninterpretable | an embedding |
| **manifest** space | specified and named in advance | this |

That is the whole trade. A manifest basis costs you an ontology and buys predicate queries,
readable explanations, and consolidation that is arithmetic rather than judgement. **The basis is
never rotated** — which is precisely what PCA and embeddings do, and why their axes have no names.

## What it is not

| cannot represent | belongs in |
|---|---|
| **role binding** — who did what to whom | a propositional store. `fox jumped over wall` and `wall jumped over fox` are the SAME coordinate |
| **relations** — `wood CRAFTS_INTO plank` | an edge table beside the space, never an axis |
| **dimensioned quantities** — 20 dps, 3m | `payload`; the coordinate holds the normalised projection |
| **counts** — "three zombies" | `payload` |
| **ambiguity between two modes** — *either* tool *or* weapon | two candidate coordinates. A point at `0.5/0.5` means *halfway*, not *one of two* |
| **sequence** | `trajectory`, not a point |
| **time, ids, recency** | filters and fields. A timestamp inside a coordinate would dominate every distance |

It is an **index, not a compression**: you cannot reconstruct a record from its position. And it is
not learned — it cannot notice that two axes are redundant or that a needed one is missing. That is
what `stats` is for.

---

## The organising principle

> **Filters narrow. Exactly one metric ranks.**

| mode | role | cost |
|---|---|---|
| time window | filter | free |
| axis predicate | filter | near-free — a scan of one contiguous column |
| *(later)* full-text, edges | filter | cheap |
| **distance in the space** | **the metric** | the only expensive step, run last over the smallest set |

That is boolean retrieval then scoring, which is how search has worked for decades. It is why a
growing feature list here is not a growing pile of comparison methods: filters are extensible one
component type at a time, and the metric is singular and designed. If an embedding is ever
admitted, it arrives as a **domain** whose axes are unnamed — so there is still one metric, and
exactly one domain that cannot explain itself.

Every query returns its **plan** — per-clause selectivity, in order. Not a debug flag: the most
common failure in a memory system is a query that silently matched nothing, and the only way to
see why is to see which clause ate the rows.

## `Region` does five jobs

One type, one threshold, five uses — which is the argument that this is a primitive rather than a
convenient data structure:

| as | operation |
|---|---|
| a **kind** | the nearest region claims the point |
| **novelty** | *no* region claims the point |
| a **consolidation target** | the centroid absorbs its members |
| a **goal state** | distance to it, plus `difference` for the named gaps |
| a **behaviour precondition** | containment decides whether it applies |

Prototypes are plural on purpose. If *building block* is really wood-like **and** stone-like, a
single centroid lands between the clusters, in empty space, matching neither.

**A radius is fitted, never chosen.** `fit()` derives it from its members (`mean + 2·sd` of
member-to-prototype distance), because an absolute constant cannot know the axis table, the domain
weights or the metric. Measured: redundant axes shrink the same-vs-other margin by 20-46% with
`recall@1` completely unmoved — so a hand-chosen radius over-claims as the space grows, and novelty
detection degrades with no symptom in retrieval. `DEFAULT_RADIUS` applies only to a region opened
from a single seed.

`membership()` decays exponentially (Shepard's law) rather than as `1 - d`. Ranking is unaffected —
both are monotone in distance — so it matters only where the value is consumed, and it has a floor:
maximum distance generalises to `e^-c ≈ 0.05`, not to 0.

## Consolidation

The thing a knowledge graph structurally cannot offer. Here it is **arithmetic with one knob**, and
monotone — always runnable harder. In a graph, "merge these into an abstraction" requires deciding
which edges survive, which requires a model.

It also degrades in the right direction: precision is lost, **position is kept**. The episode fades
while *something like this happened, in this region* survives — episodic detail decaying into gist,
falling out of the mean rather than designed in. Insertion is likewise **local and context-free**:
a coordinate is computed from the item alone, so writes never need reads.

---

## Invariants

1. **Unmeasured is not zero.** `conf[i] === 0` means nobody asked. "Not noisy" and "nobody looked at
   noisiness" are different facts and only the second is worth noticing.
2. **Distance is computed over the measured intersection, normalised per domain, and each domain is
   weighted by its completeness** — a domain compared on 3 of its 12 axes carries a quarter of its
   weight. Identity at full coverage. The one line of
   maths that had to be right first time: because appending an axis is deliberately free, treating
   unmeasured as zero would silently shift *every* existing pairwise distance the moment the ontology
   grew.
3. **No measured overlap throws.** Zero similarity and an absence of comparison must never be
   indistinguishable to a caller ranking results. `explain()` is how you *ask* instead of catching.
4. **A coordinate carries its basis.** Cross-version comparison throws rather than returning a
   plausible number.
5. **One axis, one producer.** Two disagreeing sources is a drift no query could surface.
6. **Readings are validated against `[0,1]` at the door.** Out of range is not a rounding problem; it
   breaks the normalisation every metric depends on.
7. **Coordinates are frozen.** A point does not move. History is added to, never rewritten.
8. **Predicate thresholds are rounded into the stored precision.** Columns are `Float32`; a `Float64`
   threshold of `0.8` is strictly *less* than `0.8` as stored, which made `lte: 0.8` exclude a row
   holding exactly `0.8`.
9. **A region's radius is measured from its members, not chosen.** Ranking is invariant to redundant
   axes; an absolute threshold is not. See *Measured* below.
10. **Be generous with axes.** The metric tolerates far more than a producer can afford — the limit
    is measurement, not geometry.

## The basis lifecycle

The basis is **versioned, not mutable** — so the system is dynamic while the space is stable between
migrations. The fingerprint is a content hash of the axes, so it cannot drift out of step with what
it describes.

| change | breaking? | why |
|---|---|---|
| add an axis | **no** | append-only; existing coordinates get `conf = 0` on it |
| domain weight or metric | **no** | query-time, never stored |
| remove an axis | **no** | tombstone at weight 0; physical removal only at compaction |
| **redefine an axis's question, kind or levels** | **yes** | same name, different meaning — every stored coordinate was measured against the old one |

So growth and pruning are free, and only redefinition breaks. Migration is *re-assessment from
payload into a new store, then swap* — build beside, overlap, never a gap — which is affordable
precisely because the producer is now cheap. **A cheap producer does not just make ingestion free; it
makes ontology change affordable**, which is what a learned basis requires.

Candidate axes are proposed freely, scored, and deliberately **not** part of the space. What policy
promotes them is unwritten on purpose: it needs a corpus that does not exist yet, and a promotion rule
with no data behind it is roadmap pretending to be code.

---

## Layout

```
src/
├── index.ts      Locus + public types          ← the composition-root door
├── pure.ts       space + coord, no IO          ← the producer / test door
├── space/        the basis: axes, domains, version, candidates      PURE
├── coord/        the algebra: distance, t-norms, shape, region, trajectory   PURE
├── store/        columns, planner, stats, consolidation, persistence
└── regions/      persisted concepts

lab/              experiment harness — seeded generators, committed results
```

Four nodes, one direction. `space` and `coord` are pure leaves; `store` depends on both; `regions`
depends on `store` and `coord`. The pure pair is importable without dragging SQLite into a compile —
the same rule that keeps a cognet's mechanisms testable without a world.

**Columnar, in memory, exact, 8-bit.** One `Uint8Array` per axis — 256 levels is ample for a
membership degree, and it is the difference between a million rows at 200 axes costing 400MB rather
than 1.6GB. A three-axis box query is sub-millisecond, which is why there is no approximate index and
why an ANN structure would be *actively wrong* here: it trades exactness for a speed that is already
free. Predicates compare in quantised space; dequantisation goes through a lookup table so the bulk
ranker stays bit-identical to the reference metric. SQLite holds durable rows under batched
transactions; the columns are a derived index rebuilt at load.

## Coverage

Partial coverage is the normal state, not an edge case: producers own different axes, and appending an
axis deliberately leaves older records unmeasured on it. A distance is therefore an *estimate* from
whatever axes two records share — and `near()` takes the minimum over every candidate, so a thinly
measured row can win by luck rather than by being near.

Three defences, strongest first:

1. **Keep coverage uniform.** Backfill a new axis before relying on it.
2. **One producer per domain**, and scope queries with `{ domain }`. A domain that is complete-or-absent
   per record compares on all its axes or drops out — worth ~2x at low coverage.
3. **`near(probe, { minCompleteness: 0.8 })`** — refuse to rank a candidate measured on less than 80%
   of what the probe measured. A filter, not a metric change.

```ts
locus.stats.coverage()   // per domain: complete / absent / PARTIAL. partial is the dangerous middle.

result.plan.coverage     // { min, max, mean } over what was ranked. A wide spread = untrustworthy.
result.hits[0].compared  // the sample size behind this distance
```

## Connections

```ts
{ type: "memory" }                      // no disk
{ type: "sqlite", path: "./memory.db" } // durable rows
{ type: "remote", url }                 // declared, unwired — throws
```

A `Connection` is the kernel's `MemoryConnection`: a cognet asks `kernel.memory.connect(name)` for
one and passes it straight to `Locus()`. The kernel says where the database lives and the cognet
never sees a path, so a hosted agent can be answered `remote` with nothing in the mind changing.

`memory` and `sqlite` are **one engine with a different persistence leaf**, so the in-memory
substrate is not a mock: a hot test against it exercises the real planner, metric, regions and
consolidation. `remote` is a different thing — it has no local engine at all, so it swaps the whole
handle. Declared so `LocusHandle` is the one contract both paths satisfy and the remote client can
never drift from the local one.

## Testing

```
tests/hot/    memory connection — the engine. Sub-second, no filesystem.
tests/full/   sqlite in a temp dir — durability, reload, basis validation.
```

Every engine assertion runs against `memory`; every assertion about surviving a restart runs against
`sqlite`. If an engine test needs sqlite, something in the engine reached for the disk.

## Measured

Runs in [`lab/`](./lab), results committed in [`lab/results/`](./lab/results). Seeded; `summary.md`
is generated. Reasoning and caveats live in [`PAPER.md` §11](./PAPER.md).

| finding | numbers |
|---|---|
| **Richness beats parsimony** | `recall@1` 0.750 → 0.800 → **0.888** at 24 / 72 / 144 axes (50k records, 20% distractors). By *discriminating* axes: 0.41 / 0.76 / 0.87 / **1.00** at 3 / 6 / 12 / 40. |
| **Scale is not the enemy** | `recall@1` rises 0.825 → 0.888 from 1k to 50k records at 144 axes. Denser concepts beat more confusers. |
| **Redundancy is invisible to ranking, corrosive to thresholds** | 24 duplicated noise axes moved `recall@1` less than the standard error at every signal level. Same-vs-other **margin** fell 20-46%. |
| **Partial coverage breaks ranking, and a filter fixes it** | `recall@1` 0.825 → **0.175** as coverage thins, with margin nearly unmoved — a distance is an estimate from shared axes, and `near()` takes the minimum, so thin rows win by luck. `minCompleteness: 0.8` restores **0.830 flat** on the mixed thick/thin case real producers create. Shape beats amount: the same ~12-axis budget gives 0.175 scattered vs 0.370 as one whole domain. |
| **Scale, measured** | 250k records × 144 axes: **2.8s** to load, **72MB** resident, **254ms** for an unnarrowed `near()`. A million rows at 200 axes projects to ~400MB. The linear scan is the one remaining wall — pair `near()` with a filter. |
| **Ranking must be axis-major** | `near()` at 50k × 144 axes: **184ms → 45ms** (4.1x) by inverting the loop so each column is walked once for all candidates. A candidate-major version that allocated a `Coord` per row cost 4x; one that avoided the allocation with accessor closures cost *more* (272ms) — megamorphic calls beat the garbage they removed. |

The generator plants structure and recovers it, so this validates the **store and the metric**. It
says nothing about whether human-named axes capture real structure — only a real corpus does.

## Consolidation

`O(records × leaders)` by leader clustering, not `O(records²)`. That bounds the cost; it does not
remove it — so **never consolidate the whole store.** Scope it to the rows a query returned:

```ts
const recent = await locus.records.query({ when: { from: lastSleep } })
const slots = recent.hits.map(hit => locus.records.slotOf(hit.record.id)!)

const report = await locus.records.consolidate({ radius: 0.08, slots: slots, maxLeaders: 5_000 })
// { before, after, clusters, leaders, comparisons, truncated }
```

`comparisons` makes the cost a number. `maxLeaders` is a guard for the degenerate case — nothing
clusters, so every row becomes its own leader — and `truncated` means a partial pass says so rather
than looking like a complete one that found little. Running again at the same radius is a no-op.

## Not yet built

Producers (`Mechanical`, `Table`, `Probe`, `Jev`), transitions and behaviours, edges, full-text,
a chronology index (a scan suffices at this size), and the debugger views — the axis-health matrix
first, since dead and duplicate axes are invisible from reading the axis table.

Each is additive: a new component type plus a new filter. If adding one forces a change to `space/`
or `coord/`, a boundary was wrong.

## References

- Gärdenfors, *Conceptual Spaces: The Geometry of Thought* (MIT Press, 2000) — domains, convex regions, prototypes as centroids
- Zadeh, "Fuzzy Sets" (1965) — graded membership; t-norms are the valid ANDs
- Osgood, *The Measurement of Meaning* (1957) — named-axis rating, and that it recovers real structure
- Bellmund, Gärdenfors, Moser & Doeller, "Navigating cognition: Spatial codes for human thinking" (*Science*, 2018) — conceptual spaces meet grid cells
- Lampert et al., "Learning to detect unseen object classes by between-class attribute transfer" (2009) — named attributes supporting classes never trained on
- Shepard, "Toward a universal law of generalization for psychological science" (*Science*, 1987) — exponential decay of similarity; what `generalisation()` implements
- Tulving & Thomson, "Encoding specificity and retrieval processes in episodic memory" (1973) — more encoded attributes means more retrieval cues
- Ferns, Panangaden & Precup, "Metrics for finite Markov decision processes" (2004) — bisimulation metrics: the criterion for whether a basis is rich enough
- Plate, *Holographic Reduced Representations* — where role binding lives, and the price it charges

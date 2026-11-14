# lab

Experiments that validate the store and the metric. `bun run lab <name>` or `bun run lab` for all.

Results are committed to `results/`, and `results/summary.md` is **generated** from the JSON — never
hand-written, so a write-up cannot drift from what actually ran. Every generator is seeded.

## The one rule

**The generator is the experiment.** Plant isotropic Gaussian clusters in an orthogonal space and a
euclidean metric recovers them perfectly at any size — proving only that the metric can find
structure built from its own assumptions. Two rounds of this bench produced meaningless numbers
before `synth.ts` was adversarial enough: first a ceiling at `recall@1 = 1.000` everywhere, then a
null result from sweeping the wrong variable.

So `synth.ts` carries a knob per claim the package makes:

| knob | attacks |
|---|---|
| `overlap` | difficulty, defined relative to measured region separation so one setting means the same thing at 20 axes and at 120 |
| `zipf` | that recall is not balanced-class luck |
| `bimodal` | Criterion P, and whether multi-prototype rescues a two-mode concept |
| `duplicates` + `duplicateSource` | that redundancy dominates rankings |
| `heteroscedastic` | a single global radius |
| `distractors` | that dead axes cost little |
| `coverage` | the measured-intersection rule |
| `concentrate` | that per-domain combination helps rather than dilutes |

## Experiments

| | asks | fails if |
|---|---|---|
| `e1` | does the metric still discriminate as corpus and space grow? | `recall@1` collapses before ~1e5 at 100+ axes |
| `e2` | what does a duplicate axis cost, and do domains absorb it? | — *answered: no effect on ranking* |
| `e2b` | where does robustness to irrelevant axes end? | — *answered: margin, not ranking* |
| `e4` | does the metric hold when producers assess different axes? | — *answered: NO. recall 0.855 → 0.165* |

Planned: `e3` consolidation (compression vs region retention), `e5` sufficiency (does "same coordinate, different outcome" detect a missing axis).

## What this cannot answer

Whether human-named axes capture real structure. That is the ontology question and needs a real
corpus. Everything here is about the store and the metric.

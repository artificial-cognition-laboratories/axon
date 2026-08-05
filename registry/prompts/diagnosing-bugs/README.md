# @axon/diagnosing-bugs

Six-phase discipline for hard bugs — build a red-capable loop before theorising.

Feedback loop → reproduce and minimise → ranked hypotheses → instrument →
fix with a regression test → clean up and ask what would have prevented it.

## Install

```bash
axon install @axon/diagnosing-bugs
```

## Use

```bash
axon run @axon/diagnosing-bugs --text "export button throws on large carts"
```

From a script:

```ts
const diagnose = await axon.prompt("@axon/diagnosing-bugs")
const { stream } = axon.stream({ prompt: [diagnose] })
```

## What it does to the agent

Stops it guessing. The agent may not form a theory until it can name one
command it has actually run that goes red on your exact symptom — which is
the difference between debugging and pattern-matching on code that looks
suspicious. It also has to show you its ranked hypotheses before testing
them, so you can re-rank with what you know and it doesn't.

Phase 1 is the whole thing; the other five phases just consume the loop it
builds. It lives in `components/feedback-loop.vue` and is worth reading on
its own.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/diagnosing-bugs`), MIT © 2026 Matt Pocock.

Changed in this port: Phase 1 is split into a component, since it is half
the length of the whole prompt and stands alone. The source ships a
`hitl-loop.template.sh` for human-driven repro steps — a prompt package is
text only, so that entry describes the technique rather than shipping the
script. Tool-specific references (named browser drivers, a sibling skill
name) are generalised.

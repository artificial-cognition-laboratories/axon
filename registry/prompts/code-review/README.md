# @axon/code-review

Review a diff on two independent axes — repo standards, and the spec it came
from.

Standards asks "is this written the way this repo writes code?". Spec asks
"is this the thing that was asked for?". They are reported separately and
never re-ranked against each other.

## Install

```bash
axon install @axon/code-review
```

## Use

```bash
axon run @axon/code-review --text "review since main"
```

From a script:

```ts
const review = await axon.prompt("@axon/code-review")
const { stream } = axon.stream({ prompt: [review] })
```

## What it does to the agent

Forces it to pin a fixed point and verify the diff is real before reviewing
anything, so a typo'd branch name fails immediately instead of producing a
confident review of nothing. Then it reviews twice, separately, and reports
both — because a change that follows every convention while implementing the
wrong feature passes one axis and fails the other, and a merged report lets
the healthy axis hide the broken one.

Where no spec exists, it says so rather than inferring one and reviewing
against its own guess.

The Standards axis carries a baseline of twelve code smells in
`components/smell-baseline.vue`, so it still has something useful to say in a
repo that documents no conventions at all. Documented repo standards always
override the baseline.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/code-review`), MIT © 2026 Matt Pocock. The smell
baseline derives from Martin Fowler, *Refactoring*, ch. 3.

Changed in this port: the source requires a configured issue tracker via a
companion setup skill and hard-codes Claude Code's `Agent` tool for the
parallel sub-agents. Both are dropped — spec discovery degrades through
commit refs to a user-supplied path to asking, and the parallelism is stated
as intent ("if the runtime can run these as separate agents") rather than
naming a tool. The smell baseline is split into a component.

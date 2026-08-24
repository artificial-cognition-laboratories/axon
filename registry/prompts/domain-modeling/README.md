# @axon/domain-modeling

Sharpen a project's domain language and record the decisions worth keeping.

The active discipline: challenging terms as they are used, stress-testing
relationships with concrete scenarios, and writing the glossary and the
decisions down the moment they crystallise.

## Install

```bash
axon install @axon/domain-modeling
```

## Use

```bash
axon run @axon/domain-modeling --text "we keep saying account and meaning two things"
```

From a script:

```ts
const modeling = await axon.prompt("@axon/domain-modeling")
const { stream } = axon.stream({ prompt: [modeling] })
```

## What it does to the agent

Stops it nodding along to ambiguous language. It challenges a term the moment
it conflicts with what is already written down, proposes a canonical word when
one is fuzzy, and invents edge-case scenarios to force precision about where
one concept ends and the next begins.

The move that earns its keep: it cross-references what you say against what the
code does, and surfaces every contradiction. "Your code cancels whole orders,
but you just said partial cancellation works — which is right?" That question
is always worth asking, because either the model or the code is wrong.

It is deliberately reluctant about recording decisions — three tests must all
pass first. A directory of decisions that were never really decisions trains
everyone to skim it.

Formats for both artifacts live in `components/formats.vue`.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/domain-modeling`), MIT © 2026 Matt Pocock.

Changed in this port: the source's two format files are merged into one
component. Specific filenames and directory layouts (`CONTEXT.md`,
`docs/adr/`, `CONTEXT-MAP.md`) are described by role rather than named, so the
prompt fits a repo that already keeps these things somewhere else.

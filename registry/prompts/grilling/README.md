# @axon/grilling

Stress-test a plan through a relentless one-question-at-a-time interview.

Walks the decision tree branch by branch, resolving dependencies in order, with
a recommended answer attached to every question.

## Install

```bash
axon install @axon/grilling
```

## Use

```bash
axon run @axon/grilling --text "here's how I want to structure the billing service"
```

From a script:

```ts
const grill = await axon.prompt("@axon/grilling")
const { stream } = axon.stream({ prompt: [grill] })
```

## What it does to the agent

Two constraints do the work. It asks **one** question at a time and waits —
several at once gets you a partial answer to the easiest one. And it
**recommends an answer to every question**, so "which database?" becomes "I'd
use Postgres, because X — agree?", which you can settle in three seconds or
push back on with specifics.

It also looks things up instead of asking. Anything discoverable from the
codebase or a tool is its job; only genuine decisions come to you. And it will
not touch a file until you both agree the understanding is shared.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/productivity/grilling`), MIT © 2026 Matt Pocock.

Changed in this port: the "what to press on" list — unstated assumptions,
failure modes, scope edges, reversal cost, the rejected alternative — and the
closing playback are additions. The source specifies the interview's mechanics
precisely but leaves the targets to the model.

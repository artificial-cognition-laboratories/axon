# @axon/prototype

Build throwaway code that answers one design question, then capture the answer.

Identify which question is being asked, build the smallest thing that answers it, capture the verdict.

## Install

```bash
axon install @axon/prototype
```

## Use

```bash
axon run @axon/prototype --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/prototype")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Makes it identify the question first — a state-model question and a what-should-this-look-like question produce completely different artifacts, and getting it wrong wastes the whole exercise. Then it deliberately skips the polish: no tests, no abstractions, no persistence. Production instincts actively cost you in a prototype.

It reports honestly when the prototype killed the idea, which is a prototype succeeding.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/prototype`), MIT © 2026 Matt Pocock.

Changed in this port: the source branches to two companion files for its two
question types; here both are described inline, since a prompt renders to one
string and the branch is a paragraph either way. Tool- and
framework-specific details are generalised.

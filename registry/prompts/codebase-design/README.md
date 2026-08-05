# @axon/codebase-design

Design deep modules — small interfaces, clean seams, testable through them.

A shared vocabulary for talking about code structure precisely: module,
interface, depth, seam, adapter, leverage, locality. Use it when designing a
module's interface, deciding where a seam goes, or making code more testable.

## Install

```bash
axon install @axon/codebase-design
```

## Use

```bash
axon run @axon/codebase-design --text "the session manager is getting unwieldy"
```

From a script:

```ts
const design = await axon.prompt("@axon/codebase-design")
const { stream } = axon.stream({ prompt: [design] })
```

## What it does to the agent

Gives it exact words and holds it to them, so "this should be a service"
becomes "this module's interface is too large for what sits behind it, and the
seam is in the wrong place". Vague structural advice is usually vague thinking;
the vocabulary is what makes the disagreement specific enough to resolve.

It also carries four principles that kill most bad restructurings on sight —
the deletion test, depth being a property of the interface rather than the
implementation, the interface being the test surface, and not building a seam
until two things actually vary across it.

The glossary lives in `components/glossary.vue` and is worth reading alone.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/codebase-design`), MIT © 2026 Matt Pocock. The seam
concept is Michael Feathers, *Working Effectively with Legacy Code*; the deep
module framing responds to John Ousterhout, *A Philosophy of Software Design*.

Changed in this port: the glossary is split into a component. The source's
ASCII diagrams for deep and shallow modules are stated in prose, since they
carried no information the sentence next to them did not. The closing "when
applying this" section is an addition — the source defines the vocabulary but
does not say what to do with it on a live piece of code. The two companion
files (`DEEPENING.md`, `DESIGN-IT-TWICE.md`) are not ported; the latter
depends on spawning parallel sub-agents.

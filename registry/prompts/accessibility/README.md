# @axon/accessibility

Make an interface work by keyboard, screen reader, and at high zoom.

Semantics first, then keyboard, perception, and dynamic behaviour. Verify manually.

## Install

```bash
axon install @axon/accessibility
```

## Use

```bash
axon run @axon/accessibility --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/accessibility")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Leads with the highest-value move — using the right element, since a native button gets focus, keyboard activation, and correct announcement for free, none of which a clickable div has. It reaches for ARIA only where nothing native fits, because incorrect ARIA is worse than none. It also does the two manual passes that catch what automated checks miss.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.

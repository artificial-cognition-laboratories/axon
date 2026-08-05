# @axon/error-handling

Decide what can fail, where it's caught, and what must never be swallowed.

Validate at boundaries, trust the interior, catch only where you can act.

## Install

```bash
axon install @axon/error-handling
```

## Use

```bash
axon run @axon/error-handling --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/error-handling")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Encodes the rule that matters most: never silently swallow an error. A catch that logs and continues, a fallback masking a broken assumption, a default hiding a null that should never be null — each converts a loud findable failure into a quiet permanent one.

It checks for the specific shapes this takes: empty catches, unawaited promises, catch-alls at the wrong level, and errors dropped inside loops so a wholly failed run reports success.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.

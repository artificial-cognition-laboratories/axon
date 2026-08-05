# @axon/implement

Build from a spec in vertical slices, with tight feedback and honest
reporting.

The disciplined version of "just write the code": restate the goal, build one
thin end-to-end path at a time, typecheck and test as you go, and report what
actually happened.

## Install

```bash
axon install @axon/implement
```

## Use

```bash
axon run @axon/implement --text "build the export endpoint from docs/spec.md"
```

Pairs well with `@axon/tdd` for the inner loop and `@axon/code-review` at the
end:

```ts
const implement = await axon.prompt("@axon/implement")
const tdd = await axon.prompt("@axon/tdd")
const { stream } = axon.stream({ prompt: [implement, tdd] })
```

## What it does to the agent

Keeps it honest over a long stretch of work. It restates the goal before
starting, so a misread spec surfaces in seconds rather than at the end. It
builds vertical slices instead of finishing every layer in turn, so each
slice can inform the next. It runs things continuously rather than writing
for an hour and debugging for an hour.

Most usefully, it will not silently expand scope, and it will not tell you
the suite passes when it doesn't — incomplete or blocked work gets reported
as incomplete or blocked.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/implement`), MIT © 2026 Matt Pocock.

Changed in this port: the source is eight lines that mostly delegate to
sibling skills (`/tdd`, `/code-review`) and end with "commit your work".
Those cross-references don't survive being packaged alone, so the delegated
substance is stated directly — vertical slices, the typecheck and test
cadence, scope discipline, and the completion checklist. The automatic commit
is dropped: committing on the user's behalf is a decision for the caller, not
a default buried in a prompt.

# @axon/handoff

Compact a session into a document another agent can resume the work from.

Goal, state, decisions, dead ends, open questions, next step — written to a
temporary location, referencing existing artifacts rather than restating them.

## Install

```bash
axon install @axon/handoff
```

## Use

```bash
axon run @axon/handoff --text "next session is finishing the auth migration"
```

From a script:

```ts
const handoff = await axon.prompt("@axon/handoff")
const { stream } = axon.stream({ prompt: [handoff] })
```

## What it does to the agent

Produces something the next agent can act on rather than a transcript summary.
The section that matters most is what was tried and failed, with reasons: that
is the only part of a session which cannot be recovered from the repo, and the
part that otherwise gets rediscovered the expensive way.

It writes outside the workspace, references specs and issues by path instead of
duplicating them, redacts secrets, and is required to be honest about state —
an over-confident handoff is worse than none, because the next agent builds on
a foundation it was told was solid.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/productivity/handoff`), MIT © 2026 Matt Pocock.

Changed in this port: the source specifies where to write, what not to
duplicate, and to redact secrets. The contents — goal, state, decisions, dead
ends, open questions, next step — and the honesty requirement are additions;
the source names a "suggested skills" section, which here becomes the closing
note on what context to load.

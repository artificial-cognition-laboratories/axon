# @axon/tdd

Build a feature or fix a bug test-first, one vertical slice at a time.

Red → green, with the parts that make the loop produce tests worth keeping:
what a good test is, which seam to test at, when to mock, and the three
anti-patterns that quietly make a suite worthless.

## Install

```bash
axon install @axon/tdd
```

## Use

```bash
axon run @axon/tdd --text "add cart checkout"
```

From a script:

```ts
const tdd = await axon.prompt("@axon/tdd")
const { stream } = axon.stream({ prompt: [tdd] })
```

## What it does to the agent

Constrains it to one seam, one failing test, one minimal implementation per
cycle — and requires it to confirm the seam with you before writing anything.
The constraints are the point: it will not bulk-write tests, will not mock
your internals, and will not weaken a failing assertion to reach green.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/tdd`), MIT © 2026 Matt Pocock.

Changed in this port: the source's `tests.md` and `mocking.md` are inlined —
Claude Code reads linked files lazily to save context, whereas Axon renders a
prompt to a single string, so the split cost a hop and bought nothing. The
explicit numbered loop, and the "never weaken a test" and "a test that has
never failed" rules, are additions.

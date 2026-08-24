# @axon/resolving-merge-conflicts

Resolve a merge or rebase by understanding both intents before picking.

Five steps: see the state, read why each side changed what it did, resolve
each hunk preserving both intents, run the project's checks, finish the merge.

## Install

```bash
axon install @axon/resolving-merge-conflicts
```

## Use

```bash
axon run @axon/resolving-merge-conflicts --text "rebase onto main is conflicting"
```

From a script:

```ts
const resolve = await axon.prompt("@axon/resolving-merge-conflicts")
const { stream } = axon.stream({ prompt: [resolve] })
```

## What it does to the agent

Forces it to read the commit messages, PRs, and issues behind both sides
before touching a hunk. That step is the one that gets skipped, and skipping it
is how you get a resolution that compiles, passes, and quietly deletes a fix
somebody shipped last week.

It will not invent new behaviour to escape a hard conflict, will not abort, and
will report every place it had to choose one side over the other — those are
decisions made on your behalf and you should see them.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/resolving-merge-conflicts`), MIT © 2026 Matt Pocock.

Changed in this port: the semantic-conflict warning (changes that merge
cleanly but disagree about behaviour), the guidance on treating a
post-merge test failure as probably correct, and the closing requirement to
report every side chosen, are additions. The source's final step commits the
result; here it stops at completing the merge, since committing is the
caller's decision.

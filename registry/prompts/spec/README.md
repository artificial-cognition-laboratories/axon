# @axon/spec

Turn a discussion into a written spec, without inventing what wasn't decided.

Synthesis, not an interview. Seams agreed up front, requirements that are observable.

## Install

```bash
axon install @axon/spec
```

## Use

```bash
axon run @axon/spec --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/spec")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Synthesises what's already been discussed instead of restarting requirements gathering. It agrees the test seams before writing, since getting those wrong invalidates the testing section.

Two constraints keep it honest: no file paths or code snippets in implementation decisions, because they go stale faster than anything else and are the first thing that makes a spec untrustworthy; and anything not actually decided goes to open questions rather than being quietly filled in.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/to-spec`), MIT © 2026 Matt Pocock.

Changed in this port: the source publishes to a configured issue tracker and
applies a triage label; here the spec is a document and where it goes is the
caller's decision. The "open questions" section and the rule against
inventing undiscussed requirements are additions.

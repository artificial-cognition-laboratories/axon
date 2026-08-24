# @axon/research

Investigate against primary sources and write cited findings to a durable
file.

Official docs, source code, specs, and first-party APIs — not a blog post
about them. The output is a markdown file in the repo, so the reading only
has to happen once.

## Install

```bash
axon install @axon/research
```

## Use

```bash
axon run @axon/research --text "how does the GCS FUSE mount handle concurrent writes"
```

From a script:

```ts
const research = await axon.prompt("@axon/research")
const { stream } = axon.stream({ prompt: [research] })
```

## What it does to the agent

Stops it answering from memory. Every claim has to trace to a source that
owns it, load-bearing wording gets quoted rather than paraphrased, and
anything it couldn't verify is reported as unverified instead of quietly
smoothed over. Contradictions between sources get reported as contradictions.

The result is a file rather than a chat reply — with the question, the answer
up front, the citations, what's still open, and the date and versions read.
That last part matters more than it looks: it tells a future reader when to
stop trusting the document.

## Attribution

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(`skills/engineering/research`), MIT © 2026 Matt Pocock.

Changed in this port: the source is three steps assuming a background-agent
tool is available; here that is stated as a conditional preference rather
than a requirement, so the prompt works either way. The citation rules, the
"record what you could not find" and "do not fill gaps from memory"
constraints, the contradiction handling, and the document structure are
additions — the source specifies the sourcing standard but not what the
written artifact should contain.

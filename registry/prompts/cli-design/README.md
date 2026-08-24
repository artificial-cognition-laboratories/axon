# @axon/cli-design

Design a command-line interface for both a human and a script.

Results to stdout, everything else to stderr, honest exit codes, examples in the help.

## Install

```bash
axon install @axon/cli-design
```

## Use

```bash
axon run @axon/cli-design --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/cli-design")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Serves the audience most CLIs forget: the script. Results go to standard output and everything else to standard error, which is what makes a tool composable. Exit codes are honest without exception, since a tool exiting zero having failed breaks every pipeline it's in.

It handles destructive operations properly — confirm by default, a flag to skip for scripts, and a clear failure rather than a hang when nobody can answer a prompt.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.

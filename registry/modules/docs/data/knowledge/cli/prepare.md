---
title: axon prepare
---

# axon prepare

Prepare the project at the current directory. Axon detects whether it is an
agent, module, cognet, or benchmark project and runs that project's preparation
step; there is no separate deployment-specific prepare command or `axon module prepare` to
remember.

```bash
axon prepare
```

For an agent, preparation installs declared modules, compiles its cognet, and
regenerates the authoring types. Modules and cognets regenerate their own static
type frame; benchmarks prepare their test workspace. Generated files are
project-specific and live in the project's ignored build directory.

Run it after changing declared modules, tools, prompts, or the cognet to refresh
the local authoring surface before development or publishing.

```bash
axon install @acme/github   # change the current agent project
axon prepare                # refresh that project's generated output
```

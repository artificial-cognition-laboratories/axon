---
title: axon clone
---

# axon clone

Download one published module version as an editable local project.

```bash
axon clone @axon/arxiv
axon clone @axon/arxiv@0.1.4
axon clone @axon/arxiv ./my-arxiv
```

`axon clone` retrieves the registry source artifact exactly as published. It
does not create a Git repository, configure a remote, remember an upstream, or
support pull and merge operations. Use Git for history and collaboration.

With no destination, Axon creates a directory using the module's package name:

```bash
axon clone @axon/arxiv
# → ./arxiv
```

The destination must be absent or empty. Axon runs `axon prepare` after
extracting, so the cloned project is immediately type-ready. It is otherwise a
normal module: edit it and publish it only if you own its package namespace.

## axon fork

Fork is clone plus a new package identity. It is for starting an independently
publishable derivative, rather than retrieving the original source unchanged.

```bash
axon fork @axon/arxiv --as @cody/arxiv-tools
axon fork @axon/arxiv@0.1.4 --as @cody/arxiv-tools ./arxiv-tools
```

Fork resets `package.json` to the requested name and version `0.1.0`, and keeps
immutable provenance in `package.json` under `axon.forkedFrom`. It has no Git
or registry tracking relationship with the original module.

To use a module in an agent without editing its source, use
[`axon install`](/docs/v2/cli/install) instead.
